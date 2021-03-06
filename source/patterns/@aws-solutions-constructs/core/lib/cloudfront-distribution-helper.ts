/**
 *  Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import * as cloudfront from '@aws-cdk/aws-cloudfront';
import * as s3 from '@aws-cdk/aws-s3';
import * as cdk from '@aws-cdk/core';
import * as iam from '@aws-cdk/aws-iam';
import * as api from '@aws-cdk/aws-apigateway';
import * as lambda from '@aws-cdk/aws-lambda';
import { DefaultS3Props } from './s3-bucket-defaults';
import { DefaultCloudFrontWebDistributionForS3Props, DefaultCloudFrontWebDistributionForApiGatewayProps } from './cloudfront-distribution-defaults';
import { overrideProps } from './utils';
import { deployLambdaFunction } from './lambda-helper';

// Override Cfn_Nag rule: Cloudfront TLS-1.2 rule (https://github.com/stelligent/cfn_nag/issues/384)
function updateSecurityPolicy(cfDistribution: cloudfront.CloudFrontWebDistribution) {
    const cfnCfDistribution = cfDistribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnCfDistribution.cfnOptions.metadata = {
        cfn_nag: {
            rules_to_suppress: [{
                id: 'W70',
                reason: `Since the distribution uses the CloudFront domain name, CloudFront automatically sets the security policy to TLSv1 regardless of the value of MinimumProtocolVersion`
            }]
        }
    };
    return cfDistribution;
}

function createCloudfrontLoggingBucket(scope: cdk.Construct): s3.Bucket {
    // Create the Logging Bucket
    const loggingBucket: s3.Bucket = new s3.Bucket(scope, 'CloudfrontLoggingBucket', DefaultS3Props());

    // Extract the CfnBucket from the loggingBucket
    const loggingBucketResource = loggingBucket.node.findChild('Resource') as s3.CfnBucket;

    // Override accessControl configuration and add metadata for the logging bucket
    loggingBucketResource.addPropertyOverride('AccessControl', 'LogDeliveryWrite');
    loggingBucketResource.cfnOptions.metadata = {
        cfn_nag: {
            rules_to_suppress: [{
                id: 'W35',
                reason: `This S3 bucket is used as the access logging bucket for CloudFront Distribution`
            }, {
                id: 'W51',
                reason: `This S3 bucket is used as the access logging bucket for CloudFront Distribution`
            }]
        }
    };

    return loggingBucket;
}

// Lambda@Edge function to insert the HTTP Security Headers into the response coming from the origin servers
// and before it is sent to the client
function defaultLambdaEdgeFunction(scope: cdk.Construct): lambda.Function {
    const edgeLambdaFunc: lambda.Function = deployLambdaFunction(scope, {
        code: new lambda.InlineCode("exports.handler = (event, context, callback) => { \
          const response = event.Records[0].cf.response; \
          const headers = response.headers; \
          headers['x-xss-protection'] = [ \
            { \
              key: 'X-XSS-Protection', \
              value: '1; mode=block' \
            } \
          ]; \
          headers['x-frame-options'] = [ \
            { \
              key: 'X-Frame-Options', \
              value: 'DENY' \
            } \
          ]; \
          headers['x-content-type-options'] = [ \
            { \
              key: 'X-Content-Type-Options', \
              value: 'nosniff' \
            } \
          ]; \
          headers['strict-transport-security'] = [ \
            { \
              key: 'Strict-Transport-Security', \
              value: 'max-age=63072000; includeSubdomains; preload' \
            } \
          ]; \
          headers['referrer-policy'] = [ \
            { \
              key: 'Referrer-Policy', \
              value: 'same-origin' \
            } \
          ]; \
          headers['content-security-policy'] = [ \
            { \
              key: 'Content-Security-Policy', \
              value: \"default-src 'none'; base-uri 'self'; img-src 'self'; script-src 'self'; style-src 'self' https:; object-src 'none'; frame-ancestors 'none'; font-src 'self' https:; form-action 'self'; manifest-src 'self'; connect-src 'self'\" \
             } \
          ]; \
          callback(null, response); \
        };"),
        runtime: lambda.Runtime.NODEJS_12_X,
        handler: 'index.handler'
    }, 'SetHttpSecurityHeaders');

    // Remove any environment variables as it is not supported by the Lambda@Edge functions :(
    const cfnEdgeLambdaFunction = edgeLambdaFunc.node.defaultChild as lambda.CfnFunction;
    cfnEdgeLambdaFunction.addDeletionOverride('Properties.Environment');

    return edgeLambdaFunc;
}

export function CloudFrontDistributionForApiGateway(scope: cdk.Construct,
                                                    apiEndPoint: api.RestApi,
                                                    cloudFrontDistributionProps?: cloudfront.CloudFrontWebDistributionProps | any,
                                                    httpSecurityHeaders?: boolean): cloudfront.CloudFrontWebDistribution {

    const _httpSecurityHeaders = httpSecurityHeaders ? httpSecurityHeaders : true;
    let defaultprops: cloudfront.CloudFrontWebDistributionProps;
    let edgeLambdaVersion;

    if (_httpSecurityHeaders) {
        edgeLambdaVersion = new lambda.Version(scope, "SetHttpSecurityHeadersVersion", {
            lambda: defaultLambdaEdgeFunction(scope)
        });
    }

    if (cloudFrontDistributionProps && cloudFrontDistributionProps.loggingConfig) {
        defaultprops = DefaultCloudFrontWebDistributionForApiGatewayProps(apiEndPoint,
            cloudFrontDistributionProps.loggingConfig.bucket, _httpSecurityHeaders,
            edgeLambdaVersion);
    } else {
        const loggingBucket = createCloudfrontLoggingBucket(scope);
        defaultprops = DefaultCloudFrontWebDistributionForApiGatewayProps(apiEndPoint,
            loggingBucket, _httpSecurityHeaders,
            edgeLambdaVersion);
    }

    const cfprops = cloudFrontDistributionProps ? overrideProps(defaultprops, cloudFrontDistributionProps) : defaultprops;
    // Create the Cloudfront Distribution
    const cfDistribution: cloudfront.CloudFrontWebDistribution = new cloudfront.CloudFrontWebDistribution(scope, 'CloudFrontDistribution', cfprops);
    updateSecurityPolicy(cfDistribution);

    return cfDistribution;
}

export function CloudFrontDistributionForS3(scope: cdk.Construct,
                                            sourceBucket: s3.Bucket,
                                            cloudFrontDistributionProps?: cloudfront.CloudFrontWebDistributionProps | any,
                                            httpSecurityHeaders?: boolean): cloudfront.CloudFrontWebDistribution {

    // Create CloudFront Origin Access Identity User
    const cfnOrigAccessId = new cloudfront.CfnCloudFrontOriginAccessIdentity(scope, 'CloudFrontOriginAccessIdentity', {
        cloudFrontOriginAccessIdentityConfig: {
            comment: 'Access S3 bucket content only through CloudFront'
        }
    });

    const oaiImported = cloudfront.OriginAccessIdentity.fromOriginAccessIdentityName(
        scope,
        'OAIImported',
        cfnOrigAccessId.ref
    );

    let defaultprops: cloudfront.CloudFrontWebDistributionProps;
    let edgeLambdaVersion;
    const _httpSecurityHeaders = (httpSecurityHeaders !== undefined && httpSecurityHeaders === false) ? false : true;

    if (_httpSecurityHeaders) {
        edgeLambdaVersion = new lambda.Version(scope, "SetHttpSecurityHeadersVersion", {
            lambda: defaultLambdaEdgeFunction(scope)
        });
    }

    if (cloudFrontDistributionProps && cloudFrontDistributionProps.loggingConfig) {
        defaultprops = DefaultCloudFrontWebDistributionForS3Props(sourceBucket,
            cloudFrontDistributionProps.loggingConfig.bucket, oaiImported, _httpSecurityHeaders,
            edgeLambdaVersion);
    } else {
        const loggingBucket = createCloudfrontLoggingBucket(scope);
        defaultprops = DefaultCloudFrontWebDistributionForS3Props(sourceBucket, loggingBucket,
            oaiImported, _httpSecurityHeaders,
            edgeLambdaVersion);
    }

    const cfprops = cloudFrontDistributionProps ? overrideProps(defaultprops, cloudFrontDistributionProps) : defaultprops;
    // Create the Cloudfront Distribution
    const cfDistribution: cloudfront.CloudFrontWebDistribution = new cloudfront.CloudFrontWebDistribution(scope, 'CloudFrontDistribution', cfprops);
    updateSecurityPolicy(cfDistribution);

    // Add S3 Bucket Policy to allow s3:GetObject for CloudFront Origin Access Identity User
    sourceBucket.addToResourcePolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [sourceBucket.arnForObjects('*')],
        principals: [new iam.CanonicalUserPrincipal(cfnOrigAccessId.attrS3CanonicalUserId)]
    }));

    // Extract the CfnBucketPolicy from the sourceBucket
    const bucketPolicy = sourceBucket.policy as s3.BucketPolicy;
    const sourceBucketPolicy = bucketPolicy.node.findChild('Resource') as s3.CfnBucketPolicy;
    sourceBucketPolicy.cfnOptions.metadata = {
        cfn_nag: {
            rules_to_suppress: [{
                id: 'F16',
                reason: `Public website bucket policy requires a wildcard principal`
            }]
        }
    };
    return cfDistribution;
}
