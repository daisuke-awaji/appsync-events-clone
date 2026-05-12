import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { type Construct } from "constructs";

export class DataStack extends Stack {
  public readonly connectionsTable: ddb.Table;
  public readonly subscriptionsTable: ddb.Table;
  public readonly fanoutQueue: sqs.Queue;
  public readonly fanoutDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.connectionsTable = new ddb.Table(this, "ConnectionsTable", {
      partitionKey: { name: "connectionId", type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.subscriptionsTable = new ddb.Table(this, "SubscriptionsTable", {
      partitionKey: { name: "channelPrefix", type: ddb.AttributeType.STRING },
      sortKey: { name: "sk", type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // GSI used by disconnect (bulk delete) and unsubscribe (lookup by sub id).
    this.subscriptionsTable.addGlobalSecondaryIndex({
      indexName: "byConnection",
      partitionKey: { name: "connectionId", type: ddb.AttributeType.STRING },
      sortKey: { name: "subscriptionId", type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });

    this.fanoutDlq = new sqs.Queue(this, "FanoutDlq", {
      retentionPeriod: Duration.days(14),
    });

    this.fanoutQueue = new sqs.Queue(this, "FanoutQueue", {
      visibilityTimeout: Duration.seconds(60),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: this.fanoutDlq, maxReceiveCount: 5 },
    });
  }
}
