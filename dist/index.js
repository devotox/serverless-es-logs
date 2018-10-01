"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const fs_extra_1 = __importDefault(require("fs-extra"));
const lodash_1 = __importDefault(require("lodash"));
const path_1 = __importDefault(require("path"));
const utils_1 = require("./utils");
// tslint:disable:no-var-requires
const iamLambdaTemplate = require('../templates/iam/lambda-role.json');
// tslint:enable:no-var-requires
class ServerlessEsLogsPlugin {
    constructor(serverless, options) {
        this.logProcesserDir = '_es-logs';
        this.logProcesserName = 'esLogsProcesser';
        this.defaultLambdaFilterPattern = '[timestamp=*Z, request_id="*-*", event]';
        this.defaultApiGWFilterPattern = '[apigw_request_id="*-*", event]';
        this.serverless = serverless;
        this.provider = serverless.getProvider('aws');
        this.options = options;
        this.custom = serverless.service.custom || {};
        // tslint:disable:object-literal-sort-keys
        this.hooks = {
            'after:package:initialize': this.afterPackageInitialize.bind(this),
            'after:package:createDeploymentArtifacts': this.afterPackageCreateDeploymentArtifacts.bind(this),
            'aws:package:finalize:mergeCustomProviderResources': this.mergeCustomProviderResources.bind(this),
            'before:aws:deploy:deploy:updateStack': this.beforeAwsDeployUpdateStack.bind(this),
        };
        // tslint:enable:object-literal-sort-keys
    }
    afterPackageCreateDeploymentArtifacts() {
        this.serverless.cli.log('ServerlessEsLogsPlugin.afterPackageCreateDeploymentArtifacts()');
        this.cleanupFiles();
    }
    afterPackageInitialize() {
        this.serverless.cli.log('ServerlessEsLogsPlugin.afterPackageInitialize()');
        this.formatCommandLineOpts();
        this.validatePluginOptions();
        // Add log processing lambda
        // TODO: Find the right lifecycle method for this
        this.addLogProcesser();
    }
    mergeCustomProviderResources() {
        this.serverless.cli.log('ServerlessEsLogsPlugin.mergeCustomProviderResources()');
        const { retentionInDays } = this.custom.esLogs;
        const template = this.serverless.service.provider.compiledCloudFormationTemplate;
        // Add cloudwatch subscriptions to firehose for functions' log groups
        this.addLambdaCloudwatchSubscriptions();
        // Configure Cloudwatch log retention
        if (retentionInDays !== undefined) {
            this.configureLogRetention(retentionInDays);
        }
        // Add IAM role for cloudwatch -> elasticsearch lambda
        if (this.serverless.service.provider.role) {
            lodash_1.default.merge(template.Resources, iamLambdaTemplate);
            this.patchLogProcesserRole();
        }
        else {
            // Merge log processor role policies into default role
            const updatedPolicies = template.Resources.IamRoleLambdaExecution.Properties.Policies.concat(iamLambdaTemplate.ServerlessEsLogsLambdaIAMRole.Properties.Policies);
            template.Resources.IamRoleLambdaExecution.Properties.Policies = updatedPolicies;
        }
    }
    beforeAwsDeployUpdateStack() {
        this.serverless.cli.log('ServerlessEsLogsPlugin.beforeAwsDeployUpdateStack()');
        const { includeApiGWLogs } = this.custom.esLogs;
        // Add cloudwatch subscription for API Gateway logs
        if (includeApiGWLogs === true) {
            this.addApiGwCloudwatchSubscription();
        }
    }
    formatCommandLineOpts() {
        this.options.stage = this.options.stage
            || this.serverless.service.provider.stage
            || (this.serverless.service.defaults && this.serverless.service.defaults.stage)
            || 'dev';
        this.options.region = this.options.region
            || this.serverless.service.provider.region
            || (this.serverless.service.defaults && this.serverless.service.defaults.region)
            || 'us-east-1';
    }
    validatePluginOptions() {
        const { esLogs } = this.custom;
        if (!esLogs) {
            throw new this.serverless.classes.Error(`ERROR: No configuration provided for serverless-es-logs!`);
        }
        const { endpoint, index } = esLogs;
        if (!endpoint) {
            throw new this.serverless.classes.Error(`ERROR: Must define an endpoint for serverless-es-logs!`);
        }
        if (!index) {
            throw new this.serverless.classes.Error(`ERROR: Must define an index for serverless-es-logs!`);
        }
    }
    addApiGwCloudwatchSubscription() {
        const filterPattern = this.defaultApiGWFilterPattern;
        const apiGatewayStageLogicalId = 'ApiGatewayStage';
        const processorAliasLogicalId = 'EsLogsProcesserAlias';
        const template = this.serverless.service.provider.compiledCloudFormationAliasTemplate;
        // Check if API Gateway stage exists
        if (template && template.Resources[apiGatewayStageLogicalId]) {
            const { StageName, RestApiId } = template.Resources[apiGatewayStageLogicalId].Properties;
            const subscriptionLogicalId = `${apiGatewayStageLogicalId}SubscriptionFilter`;
            const permissionLogicalId = `${apiGatewayStageLogicalId}CWPermission`;
            const processorFunctionName = template.Resources[processorAliasLogicalId].Properties.FunctionName;
            // Create permission for subscription filter
            const permission = new utils_1.LambdaPermissionBuilder()
                .withFunctionName(processorFunctionName)
                .withPrincipal({
                'Fn::Sub': 'logs.${AWS::Region}.amazonaws.com',
            })
                .withSourceArn({
                'Fn::Join': [
                    '',
                    [
                        'arn:aws:logs:',
                        {
                            Ref: 'AWS::Region',
                        },
                        ':',
                        {
                            Ref: 'AWS::AccountId',
                        },
                        ':log-group:API-Gateway-Execution-Logs_',
                        RestApiId,
                        '/*',
                    ],
                ],
            })
                .withDependsOn([processorAliasLogicalId, apiGatewayStageLogicalId])
                .build();
            // Create subscription filter
            const subscriptionFilter = new utils_1.SubscriptionFilterBuilder()
                .withDestinationArn(processorFunctionName)
                .withFilterPattern(filterPattern)
                .withLogGroupName({
                'Fn::Join': [
                    '',
                    [
                        'API-Gateway-Execution-Logs_',
                        RestApiId,
                        `/${StageName}`,
                    ],
                ],
            })
                .withDependsOn([processorAliasLogicalId, permissionLogicalId])
                .build();
            // Create subscription template
            const subscriptionTemplate = new utils_1.TemplateBuilder()
                .withResource(permissionLogicalId, permission)
                .withResource(subscriptionLogicalId, subscriptionFilter)
                .build();
            lodash_1.default.merge(template, subscriptionTemplate);
        }
    }
    addLambdaCloudwatchSubscriptions() {
        const { esLogs } = this.custom;
        const filterPattern = esLogs.filterPattern || this.defaultLambdaFilterPattern;
        const template = this.serverless.service.provider.compiledCloudFormationTemplate;
        const functions = this.serverless.service.getAllFunctions();
        const processorLogicalId = 'EsLogsProcesserLambdaFunction';
        // Add cloudwatch subscription for each function except log processer
        functions.forEach((name) => {
            if (name === this.logProcesserName) {
                return;
            }
            const normalizedFunctionName = this.provider.naming.getNormalizedFunctionName(name);
            const subscriptionLogicalId = `${normalizedFunctionName}SubscriptionFilter`;
            const permissionLogicalId = `${normalizedFunctionName}CWPermission`;
            const logGroupLogicalId = `${normalizedFunctionName}LogGroup`;
            const logGroupName = template.Resources[logGroupLogicalId].Properties.LogGroupName;
            // Create permission for subscription filter
            const permission = new utils_1.LambdaPermissionBuilder()
                .withFunctionName({
                'Fn::GetAtt': [
                    processorLogicalId,
                    'Arn',
                ],
            })
                .withPrincipal({
                'Fn::Sub': 'logs.${AWS::Region}.amazonaws.com',
            })
                .withSourceArn({
                'Fn::GetAtt': [
                    logGroupLogicalId,
                    'Arn',
                ],
            })
                .withDependsOn([processorLogicalId, logGroupLogicalId])
                .build();
            // Create subscription filter
            const subscriptionFilter = new utils_1.SubscriptionFilterBuilder()
                .withDestinationArn({
                'Fn::GetAtt': [
                    processorLogicalId,
                    'Arn',
                ],
            })
                .withFilterPattern(filterPattern)
                .withLogGroupName(logGroupName)
                .withDependsOn([processorLogicalId, permissionLogicalId])
                .build();
            // Create subscription template
            const subscriptionTemplate = new utils_1.TemplateBuilder()
                .withResource(permissionLogicalId, permission)
                .withResource(subscriptionLogicalId, subscriptionFilter)
                .build();
            lodash_1.default.merge(template, subscriptionTemplate);
        });
    }
    configureLogRetention(retentionInDays) {
        const template = this.serverless.service.provider.compiledCloudFormationTemplate;
        Object.keys(template.Resources).forEach((key) => {
            if (template.Resources[key].Type === 'AWS::Logs::LogGroup') {
                template.Resources[key].Properties.RetentionInDays = retentionInDays;
            }
        });
    }
    addLogProcesser() {
        const { index, endpoint } = this.custom.esLogs;
        const dirPath = path_1.default.join(this.serverless.config.servicePath, this.logProcesserDir);
        const filePath = path_1.default.join(dirPath, 'index.js');
        const handler = `${this.logProcesserDir}/index.handler`;
        const name = `${this.serverless.service.service}-${this.options.stage}-es-logs-plugin`;
        fs_extra_1.default.ensureDirSync(dirPath);
        fs_extra_1.default.copySync(path_1.default.resolve(__dirname, '../templates/code/logsToEs.js'), filePath);
        this.serverless.service.functions[this.logProcesserName] = {
            description: 'Serverless ES Logs Plugin',
            environment: {
                ES_ENDPOINT: endpoint,
                INDEX_PREFIX: index,
            },
            events: [],
            handler,
            memorySize: 512,
            name,
            package: {
                exclude: ['**'],
                include: [`${this.logProcesserDir}/**`],
                individually: true,
            },
            runtime: 'nodejs8.10',
            timeout: 60,
            tracing: false,
        };
    }
    patchLogProcesserRole() {
        const normalizedFunctionName = this.provider.naming.getNormalizedFunctionName(this.logProcesserName);
        const templateKey = `${normalizedFunctionName}LambdaFunction`;
        const template = this.serverless.service.provider.compiledCloudFormationTemplate;
        // Update lambda dependencies
        template.Resources[templateKey].DependsOn.push('ServerlessEsLogsLambdaIAMRole');
        template.Resources[templateKey].Properties.Role = {
            'Fn::GetAtt': [
                'ServerlessEsLogsLambdaIAMRole',
                'Arn',
            ],
        };
    }
    cleanupFiles() {
        const dirPath = path_1.default.join(this.serverless.config.servicePath, this.logProcesserDir);
        fs_extra_1.default.removeSync(dirPath);
    }
}
module.exports = ServerlessEsLogsPlugin;
//# sourceMappingURL=index.js.map