import { promises as fs } from 'fs';

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await fs.chmod(path, PRIVATE_DIRECTORY_MODE);
}

export async function writePrivateFile(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, content, {
    encoding: 'utf-8',
    mode: PRIVATE_FILE_MODE,
  });
  await fs.chmod(temporaryPath, PRIVATE_FILE_MODE);
  await fs.rename(temporaryPath, path);
}
