declare class ServerlessEsLogsPlugin {
    hooks: {
        [name: string]: () => void;
    };
    private provider;
    private serverless;
    private options;
    private custom;
    private logProcesserDir;
    private logProcesserName;
    private defaultLambdaFilterPattern;
    private defaultApiGWFilterPattern;
    constructor(serverless: any, options: {
        [name: string]: any;
    });
    private afterPackageCreateDeploymentArtifacts;
    private afterPackageInitialize;
    private mergeCustomProviderResources;
    private beforeAwsDeployUpdateStack;
    private formatCommandLineOpts;
    private validatePluginOptions;
    private addApiGwCloudwatchSubscription;
    private addLambdaCloudwatchSubscriptions;
    private configureLogRetention;
    private addLogProcesser;
    private patchLogProcesserRole;
    private cleanupFiles;
}
export = ServerlessEsLogsPlugin;
