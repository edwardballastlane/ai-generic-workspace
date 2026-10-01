'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const {
  CloudFrontClient,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
  DeleteDistributionCommand,
  GetOriginAccessControlCommand,
  DeleteOriginAccessControlCommand,
  waitUntilDistributionDeployed,
} = require('@aws-sdk/client-cloudfront');
const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} = require('@aws-sdk/client-s3');

const SCRIPT_DIR = __dirname;
const ENV_FILE = path.join(SCRIPT_DIR, '.env');
const REGION = process.env.AWS_REGION || 'us-east-1';

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    process.stderr.write('Error: .env not found. Nothing to tear down.\n');
    process.exit(1);
  }
  const vars = {};
  fs.readFileSync(ENV_FILE, 'utf8').split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k && k.trim()) vars[k.trim()] = rest.join('=').trim();
  });
  return vars;
}

function confirm(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function emptyBucket(s3, bucketName) {
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucketName,
      ContinuationToken: token,
    }));
    if (res.Contents && res.Contents.length > 0) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: { Objects: res.Contents.map(o => ({ Key: o.Key })) },
      }));
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
}

async function main() {
  const env = loadEnv();
  const { BUCKET_NAME, DIST_ID, OAC_ID } = env;

  console.log('==> This will DELETE all dashboard infrastructure:');
  console.log(`    Bucket:       ${BUCKET_NAME}`);
  console.log(`    Distribution: ${DIST_ID}`);
  console.log(`    OAC:          ${OAC_ID}`);
  console.log('');

  const answer = await confirm('Continue? (y/N) ');
  console.log('');
  if (!/^[Yy]$/.test(answer.trim())) {
    console.log('Aborted.');
    process.exit(0);
  }

  const cf = new CloudFrontClient({ region: REGION });
  const s3 = new S3Client({ region: REGION });

  console.log('==> Disabling CloudFront distribution');
  let distRes = await cf.send(new GetDistributionConfigCommand({ Id: DIST_ID }));
  let etag = distRes.ETag;
  const config = distRes.DistributionConfig;
  config.Enabled = false;
  await cf.send(new UpdateDistributionCommand({
    Id: DIST_ID,
    IfMatch: etag,
    DistributionConfig: config,
  }));

  console.log('    Waiting for distribution to disable (this takes a few minutes)...');
  await waitUntilDistributionDeployed({ client: cf, maxWaitTime: 1200 }, { Id: DIST_ID });

  console.log('==> Deleting CloudFront distribution');
  distRes = await cf.send(new GetDistributionConfigCommand({ Id: DIST_ID }));
  etag = distRes.ETag;
  await cf.send(new DeleteDistributionCommand({ Id: DIST_ID, IfMatch: etag }));

  console.log('==> Deleting OAC');
  const oacRes = await cf.send(new GetOriginAccessControlCommand({ Id: OAC_ID }));
  await cf.send(new DeleteOriginAccessControlCommand({
    Id: OAC_ID,
    IfMatch: oacRes.ETag,
  }));

  console.log('==> Emptying and deleting S3 bucket');
  await emptyBucket(s3, BUCKET_NAME);
  await s3.send(new DeleteBucketCommand({ Bucket: BUCKET_NAME }));

  fs.unlinkSync(ENV_FILE);

  console.log('');
  console.log('==> Teardown complete. All resources deleted.');
}

main().catch(err => {
  process.stderr.write((err.message || String(err)) + '\n');
  process.exit(1);
});
