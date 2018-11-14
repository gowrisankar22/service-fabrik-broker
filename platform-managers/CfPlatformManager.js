'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const BasePlatformManager = require('./BasePlatformManager');
const utils = require('../common/utils');
const assert = require('assert');
const errors = require('../common/errors');
const cloudController = require('../data-access-layer/cf').cloudController;
const logger = require('../common/logger');
const CONST = require('../common/constants');
const config = require('../common/config');
const SecurityGroupNotCreated = errors.SecurityGroupNotCreated;
const SecurityGroupNotFound = errors.SecurityGroupNotFound;
const ordinals = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

class CfPlatformManager extends BasePlatformManager {
  constructor(platform) {
    super(platform);
    this.cloudController = cloudController;
  }

  getSecurityGroupName(guid) {
    return `${CONST.SERVICE_FABRIK_PREFIX}-${guid}`;
  }

  postInstanceProvisionOperations(options) {
    if (_.get(config, 'feature.EnableSecurityGroupsOps', true)) {
      return this.createSecurityGroup(options);
    } else {
      return Promise.try(() => logger.info('Feature EnableSecurityGroupsOps set to false. Not creating security groups.'));
    }
  }

  preInstanceDeleteOperations(options) {
    if (_.get(config, 'feature.EnableSecurityGroupsOps', true)) {
      return this.deleteSecurityGroup(options);
    } else {
      return Promise.try(() => logger.info('Feature EnableSecurityGroupsOps set to false. Not deleting security groups.'));
    }
  }

  postInstanceUpdateOperations(options) {
    if (_.get(config, 'feature.EnableSecurityGroupsOps', true)) {
      return this.ensureSecurityGroupExists(options);
    } else {
      return Promise.try(() => logger.info('Feature EnableSecurityGroupsOps set to false. Not creating security groups.'));
    }
  }

  createSecurityGroup(options) {
    const name = this.getSecurityGroupName(options.guid);
    const rules = _.map(options.ipRuleOptions, opts => this.buildSecurityGroupRules(opts));
    logger.info(`Creating security group '${name}' with rules ...`, rules);
    return utils
      .retry(tries => {
        logger.info(`+-> ${ordinals[tries]} attempt to create security group '${name}'...`);
        return this.cloudController
          .createSecurityGroup(name, rules, [options.context.space_guid]);
      }, {
        maxAttempts: 4,
        minDelay: 1000
      })
      .then(securityGroup => securityGroup.metadata.guid)
      .tap(guid => logger.info(`+-> Created security group with guid '${guid}'`))
      .catch(err => {
        logger.error(`+-> Failed to create security group ${name}`, err);
        throw new SecurityGroupNotCreated(name);
      });
  }

  ensureSecurityGroupExists(options) {
    const name = this.getSecurityGroupName(options.guid);
    logger.info(`Ensuring existence of security group '${name}'...`);
    return this.cloudController
      .findSecurityGroupByName(name)
      .tap(() => logger.info('+-> Security group exists'))
      .catch(SecurityGroupNotFound, () => {
        logger.warn('+-> Security group does not exist. Trying to create it again.');
        return this.ensureTenantId(options)
          .then(() => this.createSecurityGroup(options));
      });
  }

  deleteSecurityGroup(options) {
    const name = this.getSecurityGroupName(options.guid);
    logger.info(`Deleting security group '${name}'...`);
    return this.cloudController
      .findSecurityGroupByName(name)
      .tap(securityGroup => assert.strictEqual(securityGroup.entity.name, name))
      .then(securityGroup => securityGroup.metadata.guid)
      .tap(guid => logger.info(`+-> Found security group with guid '${guid}'`))
      .then(guid => this.cloudController.deleteSecurityGroup(guid))
      .tap(() => logger.info('+-> Deleted security group'))
      .catch(SecurityGroupNotFound, err => {
        logger.warn('+-> Could not find security group');
        logger.warn(err);
      }).catch(err => {
        logger.error('+-> Failed to delete security group', err);
        throw err;
      });
  }

  ensureTenantId(options) {
    return Promise
      .try(() => _.get(options, 'context.space_guid') ? options.context.space_guid : this.cloudController.getServiceInstance(options.guid)
        .then(instance => instance.entity.space_guid)
      );
  }

  buildSecurityGroupRules(options) {
    let portRule = '1024-65535';
    if (Array.isArray(options.applicationAccessPorts) && _.size(options.applicationAccessPorts) > 0) {
      portRule = _.join(options.applicationAccessPorts, ',');
    }
    return {
      protocol: options.protocol,
      destination: _.size(options.ips) === 1 ? `${_.first(options.ips)}` : `${_.first(options.ips)}-${_.last(options.ips)}`,
      ports: portRule
    };
  }

  isTenantWhiteListed(options) {
    const orgId = _.get(options, 'context.organization_guid');
    assert.ok(orgId, 'OrgId must be present when checking for whitelisting of Tenant in CF Context');
    return this.cloudController.getOrganization(orgId)
      .tap((res) => console.log('Org Response -->', res))
      .then(org => _.includes(config.quota.whitelist, org.entity.name))
      .tap(result => logger.info(`Current org - ${orgId} is whitelisted: ${result}`));
  }

  isMultiAzDeploymentEnabled(options) {
    return Promise.try(() => {
      if (config.multi_az_enabled === CONST.INTERNAL) {
        return this.isTenantWhiteListed(options);
      } else if (config.multi_az_enabled === CONST.ALL || config.multi_az_enabled === true) {
        logger.info('+-> Multi-AZ Deployment enabled for all consumers : ${config.multi_az_enabled}');
        return true;
      } else if (config.multi_az_enabled === CONST.DISABLED || config.multi_az_enabled === false) {
        logger.info(`+-> Multi-AZ Deployment disabled for all consumers : ${config.multi_az_enabled}`);
        return false;
      }
      throw new errors.UnprocessableEntity(`config.multi_az_enabled is set to ${config.multi_az_enabled}. Allowed values: [${CONST.INTERNAL}, ${CONST.ALL}/true, ${CONST.DISABLED}/false]`);
    });
  }

}

module.exports = CfPlatformManager;