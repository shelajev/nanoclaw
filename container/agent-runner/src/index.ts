/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Uses the claude CLI directly instead of the SDK to leverage the proxy's
 * API key injection (the SDK bypasses the proxy for auth validation).
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

interface ClaudeMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
  error?: string;
}

async function runClaudeCli(
  prompt: string,
  workingDir: string,
  sessionId?: string
): Promise<{ result: string | null; newSessionId?: string }> {
  return new Promise((resolve, reject) => {
    // Build claude CLI arguments
    const args = [
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
      '-p', prompt
    ];

    // Add resume flag if we have a session ID
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    log(`Running claude CLI in ${workingDir}`);
    log(`Arguments: ${args.join(' ')}`);

    const claude = spawn('claude', args, {
      cwd: workingDir,
      env: {
        ...process.env,
        // Ensure PATH includes common locations
        PATH: `${process.env.PATH}:/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin`
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let newSessionId: string | undefined;
    let result: string | null = null;
    let lastAssistantText = '';

    claude.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;

      // Parse each line as JSON
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg: ClaudeMessage = JSON.parse(line);

          // Extract session ID from init message
          if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
            newSessionId = msg.session_id;
            log(`Session initialized: ${newSessionId}`);
          }

          // Extract result from result message
          if (msg.type === 'result' && msg.result) {
            result = msg.result;
          }

          // Also capture assistant text content
          if (msg.type === 'assistant' && msg.message?.content) {
            const textParts = msg.message.content
              .filter(c => c.type === 'text')
              .map(c => c.text || '')
              .join('');
            if (textParts) {
              lastAssistantText = textParts;
            }
          }
        } catch {
          // Not JSON, ignore
        }
      }
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
      // Log stderr for debugging
      log(`stderr: ${data.toString().trim()}`);
    });

    claude.on('close', (code) => {
      if (code === 0) {
        // Use result if available, otherwise use last assistant text
        resolve({
          result: result || lastAssistantText || null,
          newSessionId
        });
      } else {
        log(`Claude CLI exited with code ${code}`);
        log(`stdout: ${stdout}`);
        log(`stderr: ${stderr}`);
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr || 'Unknown error'}`));
      }
    });

    claude.on('error', (err) => {
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    // Close stdin since we're using -p flag for prompt
    claude.stdin.end();
  });
}

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData);
    log(`Received input for group: ${input.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Add context for scheduled tasks
  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - You are running automatically, not in response to a user message.]\n\n${input.prompt}`;
  }

  // Use WORKSPACE_GROUP env var in sandbox mode, fallback to container path
  const workingDir = process.env.WORKSPACE_GROUP || '/workspace/group';

  try {
    log('Starting agent...');

    const { result, newSessionId } = await runClaudeCli(
      prompt,
      workingDir,
      input.sessionId
    );

    log('Agent completed successfully');
    writeOutput({
      status: 'success',
      result,
      newSessionId
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
