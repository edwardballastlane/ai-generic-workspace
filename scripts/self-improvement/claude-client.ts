/**
 * Claude CLI client for self-improvement system.
 * Uses spawn with stdin to avoid command line length limits.
 */

import { spawn } from 'child_process';

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
}

/**
 * Generate text using Claude CLI.
 */
export async function generate(prompt: string, _options?: GenerateOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['--output-format', 'json', '--max-turns', '1', '-p', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Claude CLI timeout'));
    }, 120000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || !stdout) {
        const detail = stderr || stdout || 'no output';
        reject(new Error(`Claude CLI failed (code ${code}): ${detail.trim().slice(0, 500)}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        const content = parsed.result || parsed.content || parsed;

        if (typeof content === 'string') {
          resolve(content);
        } else if (Array.isArray(content) && content.length > 0) {
          // Handle content blocks
          const textBlock = content.find((b: { type?: string }) => b.type === 'text');
          resolve(textBlock?.text || JSON.stringify(content));
        } else {
          resolve(JSON.stringify(content));
        }
      } catch (err) {
        // Try to extract text from raw output
        resolve(stdout);
      }
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Check if Claude CLI is available.
 */
export async function isClaudeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Generate with batched prompts for efficiency.
 */
export async function generateBatch(
  prompts: string[],
  batchSize: number = 5
): Promise<string[]> {
  const results: string[] = [];

  for (let i = 0; i < prompts.length; i += batchSize) {
    const batch = prompts.slice(i, i + batchSize);
    const batchPrompt = batch.map((p, idx) => `=== PROMPT ${idx + 1} ===\n${p}`).join('\n\n');
    const fullPrompt = `${batchPrompt}\n\n=== INSTRUCTIONS ===\nRespond to each prompt above, separating responses with "=== RESPONSE N ===" where N is the prompt number.`;

    try {
      const response = await generate(fullPrompt);

      // Parse responses
      const responseParts = response.split(/===\s*RESPONSE\s*\d+\s*===/i).slice(1);

      for (let j = 0; j < batch.length; j++) {
        results.push(responseParts[j]?.trim() || '');
      }
    } catch (err) {
      // On error, add empty results for this batch
      for (let j = 0; j < batch.length; j++) {
        results.push('');
      }
    }
  }

  return results;
}
