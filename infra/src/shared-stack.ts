import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

export interface SharedStackProps extends StackProps {
  /** EventBridge bus name (default `agent-events`). */
  readonly eventBusName?: string;
}

/**
 * Suite-wide resources shared by every agent (contract §4): the catalog S3
 * bucket (the `catalogit` CLI publishes it; agents read it), the lifecycle
 * EventBridge bus, and the CMK that encrypts the SSM SecureString signing keys.
 */
export class SharedStack extends Stack {
  readonly catalogBucket: s3.IBucket;
  readonly eventBus: events.IEventBus;
  readonly secretsKey: kms.IKey;

  constructor(scope: Construct, id: string, props: SharedStackProps = {}) {
    super(scope, id, props);

    this.catalogBucket = new s3.Bucket(this, "Catalog", {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.eventBus = new events.EventBus(this, "Events", {
      eventBusName: props.eventBusName ?? "agent-events",
    });

    this.secretsKey = new kms.Key(this, "SecretsKey", {
      description: "leanish suite — encrypts SSM SecureString signing keys",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new CfnOutput(this, "CatalogBucketName", { value: this.catalogBucket.bucketName });
    new CfnOutput(this, "EventBusName", { value: this.eventBus.eventBusName });
  }
}
