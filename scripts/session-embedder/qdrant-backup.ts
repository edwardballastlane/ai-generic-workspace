import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { QDRANT_URL, qdrantHeaders } from '../shared/qdrant';

const COLLECTION_NAME = 'session-embeddings';

/**
 * Backup manager for Qdrant vector store
 * Exports all embeddings and saves to backup location
 */
export class QdrantBackupManager {
  private backupPath: string;

  constructor(backupPath: string) {
    this.backupPath = backupPath;
  }

  /**
   * Create backup directory if it doesn't exist
   */
  private ensureBackupDir(): void {
    if (!fs.existsSync(this.backupPath)) {
      fs.mkdirSync(this.backupPath, { recursive: true });
    }
  }

  /**
   * Get all points from Qdrant collection using scroll API
   */
  private async getAllPoints(): Promise<any[]> {
    const points = [];
    const limit = 100;
    let pointOffset: number | null = null;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const body: any = {
          limit,
          with_payload: true,
          with_vector: true,
        };

        if (pointOffset !== null) {
          body.offset = pointOffset;
        }

        const response = await fetch(
          `${QDRANT_URL}/collections/${COLLECTION_NAME}/points/scroll`,
          {
            method: 'POST',
            headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
          }
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch points: ${response.statusText}`);
        }

        const data = await response.json() as { result?: { points?: any[], next_page_offset?: number | null } };
        const batchPoints = data.result?.points || [];

        if (batchPoints.length === 0) {
          break;
        }

        points.push(...batchPoints);

        // Check if there are more points to fetch
        pointOffset = data.result?.next_page_offset ?? null;
        if (pointOffset === null) {
          break;
        }

        // Log progress
        process.stdout.write(`\r   Fetching points: ${points.length}`);
      }

      console.log('');
      return points;
    } catch (error) {
      console.error('Error fetching points:', error);
      throw error;
    }
  }

  /**
   * Get collection metadata
   */
  private async getCollectionInfo(): Promise<any> {
    try {
      const response = await fetch(`${QDRANT_URL}/collections/${COLLECTION_NAME}`, {
        method: 'GET',
        headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch collection info: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching collection info:', error);
      throw error;
    }
  }

  /**
   * Clean up old backups (keep only 1)
   */
  private cleanupOldBackups(): void {
    try {
      const files = fs.readdirSync(this.backupPath)
        .filter(f => f.startsWith('qdrant-backup-') && f.endsWith('.json'))
        .sort()
        .reverse();

      // Keep only the most recent backup
      for (let i = 1; i < files.length; i++) {
        const oldBackup = path.join(this.backupPath, files[i]);
        fs.unlinkSync(oldBackup);
        console.log(chalk.gray(`   Removed old backup: ${files[i]}`));
      }
    } catch (error) {
      console.error('Error cleaning up old backups:', error);
    }
  }

  /**
   * Perform full backup of Qdrant data
   */
  async backup(): Promise<void> {
    console.log(chalk.cyan('\n🔄 Starting Qdrant backup...'));

    try {
      this.ensureBackupDir();

      // Fetch all data
      console.log(chalk.gray('   Fetching all embeddings from Qdrant...'));
      const points = await this.getAllPoints();
      const collectionInfo = await this.getCollectionInfo();

      const backupData = {
        timestamp: new Date().toISOString(),
        collection: COLLECTION_NAME,
        collectionInfo,
        points,
        pointCount: points.length,
      };

      // Generate timestamp for filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + new Date().getTime();
      const backupFile = path.join(this.backupPath, `qdrant-backup-${timestamp}.json`);

      // Write backup using streaming to avoid memory overflow with large datasets
      const writeStream = fs.createWriteStream(backupFile);

      await new Promise<void>((resolve, reject) => {
        writeStream.on('error', reject);

        // Write opening brace and metadata
        writeStream.write('{\n  "timestamp": "' + backupData.timestamp + '",\n');
        writeStream.write('  "collection": "' + backupData.collection + '",\n');
        writeStream.write('  "collectionInfo": ' + JSON.stringify(backupData.collectionInfo, null, 2).split('\n').join('\n  ') + ',\n');
        writeStream.write('  "pointCount": ' + backupData.pointCount + ',\n');
        writeStream.write('  "points": [\n');

        // Write points one at a time
        const points = backupData.points;
        for (let i = 0; i < points.length; i++) {
          writeStream.write('    ' + JSON.stringify(points[i]));
          if (i < points.length - 1) {
            writeStream.write(',\n');
          } else {
            writeStream.write('\n');
          }
        }

        writeStream.write('  ]\n}');
        writeStream.end();

        writeStream.on('finish', () => {
          const fileSizeMB = (fs.statSync(backupFile).size / (1024 * 1024)).toFixed(2);

          console.log(chalk.green(`   ✅ Backup saved: ${path.basename(backupFile)}`));
          console.log(chalk.gray(`   Size: ${fileSizeMB} MB`));
          console.log(chalk.gray(`   Points: ${backupData.pointCount}`));

          // Clean up old backups
          this.cleanupOldBackups();

          console.log(chalk.green('\n✨ Qdrant backup complete!\n'));
          resolve();
        });
      });
    } catch (error) {
      console.error(chalk.red('\n❌ Backup failed:'), error);
      throw error;
    }
  }

  /**
   * Restore from backup
   */
  async restore(backupFile?: string): Promise<void> {
    try {
      let restoreFile = backupFile;

      if (!restoreFile) {
        // Find most recent backup
        const files = fs.readdirSync(this.backupPath)
          .filter(f => f.startsWith('qdrant-backup-') && f.endsWith('.json'))
          .sort()
          .reverse();

        if (files.length === 0) {
          console.error('No backup files found');
          return;
        }

        restoreFile = path.join(this.backupPath, files[0]);
      }

      console.log(chalk.cyan(`\n🔄 Restoring from: ${path.basename(restoreFile)}`));

      const backupContent = fs.readFileSync(restoreFile, 'utf8');
      const backupData = JSON.parse(backupContent);

      const points = backupData.points || [];
      console.log(chalk.gray(`   Found ${points.length} points to restore`));

      // Restore points in batches
      const batchSize = 100;
      for (let i = 0; i < points.length; i += batchSize) {
        const batch = points.slice(i, Math.min(i + batchSize, points.length));

        const response = await fetch(
          `${QDRANT_URL}/collections/${COLLECTION_NAME}/points?wait=true`,
          {
            method: 'PUT',
            headers: qdrantHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ points: batch }),
          }
        );

        if (!response.ok) {
          throw new Error(`Failed to restore points: ${response.statusText}`);
        }

        process.stdout.write(`\r   Restored: ${Math.min(i + batchSize, points.length)}/${points.length}`);
      }

      console.log('\n' + chalk.green('✅ Restore complete!'));
    } catch (error) {
      console.error(chalk.red('Restore failed:'), error);
      throw error;
    }
  }
}
