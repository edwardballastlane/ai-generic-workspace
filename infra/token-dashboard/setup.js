'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const {
  S3Client,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketPolicyCommand,
} = require('@aws-sdk/client-s3');
const {
  CloudFrontClient,
  CreateOriginAccessControlCommand,
  CreateDistributionCommand,
} = require('@aws-sdk/client-cloudfront');

const SCRIPT_DIR = __dirname;
const ENV_FILE = path.join(SCRIPT_DIR, '.env');
const REGION = process.env.AWS_REGION || 'us-east-1';

// WORKSPACE_NAME drives the S3 bucket prefix, OAC name, and distribution
// CallerReference so multiple workspaces can coexist in the same AWS account.
// Defaults to 'workspace' when unset; sanitised to lowercase + [a-z0-9-].
const WORKSPACE_NAME = (process.env.WORKSPACE_NAME || 'workspace')
  .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
  .replace(/^-|-$/g, '') || 'workspace';
const DISTRIBUTION_COMMENT = process.env.WORKSPACE_NAME
  ? `${process.env.WORKSPACE_NAME} Token Dashboard`
  : 'Token Dashboard';

function isAlreadyExistsError(err) {
  const name = err.name || err.Code || err.__type || '';
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
}

function isCredentialsError(err) {
  const name = err.name || '';
  if (name === 'CredentialsProviderError') return true;
  if (/credentials/i.test(err.message || '')) return true;
  return false;
}

async function main() {
  const sts = new STSClient({ region: REGION });

  let accountId;
  try {
    const out = await sts.send(new GetCallerIdentityCommand({}));
    accountId = out.Account;
  } catch (err) {
    if (isCredentialsError(err)) {
      process.stderr.write(
        'AWS credentials not found. Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or configure AWS_PROFILE.\n'
      );
      process.exit(1);
    }
    throw err;
  }

  const bucketName = `${WORKSPACE_NAME}-token-dashboard-${accountId}`;
  const s3 = new S3Client({ region: REGION });
  const cf = new CloudFrontClient({ region: REGION });

  console.log(`==> Creating S3 bucket: ${bucketName}`);
  const createBucketInput = { Bucket: bucketName };
  if (REGION !== 'us-east-1') {
    createBucketInput.CreateBucketConfiguration = { LocationConstraint: REGION };
  }
  try {
    await s3.send(new CreateBucketCommand(createBucketInput));
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      process.stderr.write(
        `Bucket already exists: ${bucketName}. Run teardown.js first.\n`
      );
      process.exit(1);
    }
    throw err;
  }

  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: bucketName,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  }));

  console.log('==> Creating CloudFront Origin Access Control');
  const oacResult = await cf.send(new CreateOriginAccessControlCommand({
    OriginAccessControlConfig: {
      Name: `${WORKSPACE_NAME}-dashboard-oac`,
      Description: 'OAC for token dashboard',
      SigningProtocol: 'sigv4',
      SigningBehavior: 'always',
      OriginAccessControlOriginType: 's3',
    },
  }));
  const oacId = oacResult.OriginAccessControl.Id;
  console.log(`    OAC ID: ${oacId}`);

  console.log('==> Creating CloudFront distribution');
  const distResult = await cf.send(new CreateDistributionCommand({
    DistributionConfig: {
      CallerReference: `${WORKSPACE_NAME}-dashboard-${Date.now()}`,
      Comment: DISTRIBUTION_COMMENT,
      Enabled: true,
      DefaultRootObject: 'index.html',
      Aliases: { Quantity: 0, Items: [] },
      Origins: {
        Quantity: 1,
        Items: [{
          Id: `S3-${bucketName}`,
          DomainName: `${bucketName}.s3.${REGION}.amazonaws.com`,
          OriginAccessControlId: oacId,
          OriginPath: '',
          CustomHeaders: { Quantity: 0, Items: [] },
          S3OriginConfig: { OriginAccessIdentity: '' },
          ConnectionAttempts: 3,
          ConnectionTimeout: 10,
          OriginShield: { Enabled: false },
        }],
      },
      OriginGroups: { Quantity: 0, Items: [] },
      DefaultCacheBehavior: {
        TargetOriginId: `S3-${bucketName}`,
        ViewerProtocolPolicy: 'redirect-to-https',
        AllowedMethods: {
          Quantity: 2,
          Items: ['GET', 'HEAD'],
          CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
        },
        CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
        Compress: true,
        SmoothStreaming: false,
        FieldLevelEncryptionId: '',
        LambdaFunctionAssociations: { Quantity: 0, Items: [] },
        FunctionAssociations: { Quantity: 0, Items: [] },
        TrustedSigners: { Enabled: false, Quantity: 0, Items: [] },
        TrustedKeyGroups: { Enabled: false, Quantity: 0, Items: [] },
      },
      CacheBehaviors: { Quantity: 0, Items: [] },
      CustomErrorResponses: {
        Quantity: 1,
        Items: [{
          ErrorCode: 403,
          ResponsePagePath: '/index.html',
          ResponseCode: '200',
          ErrorCachingMinTTL: 10,
        }],
      },
      Logging: { Enabled: false, IncludeCookies: false, Bucket: '', Prefix: '' },
      PriceClass: 'PriceClass_100',
      ViewerCertificate: {
        CloudFrontDefaultCertificate: true,
        MinimumProtocolVersion: 'TLSv1',
        CertificateSource: 'cloudfront',
      },
      Restrictions: {
        GeoRestriction: { RestrictionType: 'none', Quantity: 0, Items: [] },
      },
      WebACLId: '',
      HttpVersion: 'http2',
      IsIPV6Enabled: true,
      Staging: false,
    },
  }));
  const distId = distResult.Distribution.Id;
  const distDomain = distResult.Distribution.DomainName;
  console.log(`    Distribution ID: ${distId}`);
  console.log(`    Domain: https://${distDomain}`);

  console.log('==> Attaching S3 bucket policy for CloudFront access');
  const bucketPolicy = {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'AllowCloudFrontServicePrincipal',
      Effect: 'Allow',
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: 's3:GetObject',
      Resource: `arn:aws:s3:::${bucketName}/*`,
      Condition: {
        StringEquals: {
          'AWS:SourceArn': `arn:aws:cloudfront::${accountId}:distribution/${distId}`,
        },
      },
    }],
  };
  await s3.send(new PutBucketPolicyCommand({
    Bucket: bucketName,
    Policy: JSON.stringify(bucketPolicy),
  }));

  console.log('');
  console.log('==> Setup complete!');
  console.log(`    Bucket:       ${bucketName}`);
  console.log(`    Distribution: ${distId}`);
  console.log(`    URL:          https://${distDomain}`);
  console.log('');
  console.log('    Save these values. Run deploy.sh to upload the dashboard.');
  console.log('    Note: CloudFront may take 5-10 minutes to fully deploy.');

  fs.writeFileSync(
    ENV_FILE,
    `BUCKET_NAME=${bucketName}\nDIST_ID=${distId}\nDIST_DOMAIN=${distDomain}\nOAC_ID=${oacId}\n`,
    { mode: 0o600 }
  );

  console.log('    Config saved to infra/token-dashboard/.env');
}

main().catch(err => {
  process.stderr.write((err.message || String(err)) + '\n');
  process.exit(1);
});
