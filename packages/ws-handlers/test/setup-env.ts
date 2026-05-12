/**
 * Set environment variables before any handler module loads, since handlers
 * lazily memoize the env on first use.
 */
process.env.CONNECTIONS_TABLE = "TestConnections";
process.env.SUBSCRIPTIONS_TABLE = "TestSubscriptions";
process.env.FANOUT_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue";
process.env.AWS_REGION = "us-east-1";
process.env.API_KEY = "test-api-key";
