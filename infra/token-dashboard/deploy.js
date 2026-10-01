'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');

const SCRIPT_DIR = __dirname;
const ENV_FILE = path.join(SCRIPT_DIR, '.env');
const DEFAULT_DASHBOARD = path.join(
  __dirname, '..', '..', '.claude', 'visualizations', 'token-dashboard.html'
);

function loadEnv() {
  if (process.env.S3_BUCKET && process.env.CLOUDFRONT_DIST_ID) {
    return { bucketName: process.env.S3_BUCKET, distId: process.env.CLOUDFRONT_DIST_ID };
  }
  if (!fs.existsSync(ENV_FILE)) {
    process.stderr.write('Error: .env not found. Run setup.js first (or set S3_BUCKET + CLOUDFRONT_DIST_ID).\n');
    process.exit(1);
  }
  const vars = {};
  fs.readFileSync(ENV_FILE, 'utf8').split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k && k.trim()) vars[k.trim()] = rest.join('=').trim();
  });
  return { bucketName: vars.BUCKET_NAME, distId: vars.DIST_ID };
}

async function main() {
  const dashboardFile = process.argv[2] || DEFAULT_DASHBOARD;
  if (!fs.existsSync(dashboardFile)) {
    process.stderr.write(`Error: Dashboard file not found at ${dashboardFile}\nGenerate it first with: npm run tokens:dashboard\n`);
    process.exit(1);
  }
  const { bucketName, distId } = loadEnv();
  const region = process.env.AWS_REGION || 'us-east-1';
  const s3 = new S3Client({ region });
  const cf = new CloudFrontClient({ region });

  console.log(`==> Uploading dashboard to s3://${bucketName}/`);
  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: 'index.html',
    Body: fs.readFileSync(dashboardFile),
    ContentType: 'text/html',
    CacheControl: 'max-age=300',
  }));

  console.log('==> Invalidating CloudFront cache');
  const inv = await cf.send(new CreateInvalidationCommand({
    DistributionId: distId,
    InvalidationBatch: {
      CallerReference: Date.now().toString(),
      Paths: { Quantity: 1, Items: ['/*'] },
    },
  }));
  console.log(`    Invalidation: ${inv.Invalidation.Id}`);
  console.log('==> Deploy complete!');
}

main().catch(err => { process.stderr.write(err.message + '\n'); process.exit(1); });
