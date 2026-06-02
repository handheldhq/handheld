import {
  closeSync,
  existsSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const NOFOLLOW_READ_FLAGS = constants.O_RDONLY | noFollowFlag();
const NOFOLLOW_WRITE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollowFlag();

export const AGENT_SPACE_DIRNAME = "agent-space";
export const AGENT_SPACE_DOMAIN_SKILLS_DIR = ["skills", "domain"] as const;
export const AGENT_SPACE_IMPORT_MANIFEST = "import-manifest.json";

export type DomainSkillFile = {
  path: string;
  absolutePath: string;
};

export type ImportedDomainSkills = {
  imported: DomainSkillFile[];
  manifestPath: string;
  projectDomainSkillsDir: string;
  runDomainSkillsDir: string;
};

export function agentSpaceDir(rootDir = process.cwd()): string {
  return resolve(rootDir, AGENT_SPACE_DIRNAME);
}

export function domainSkillsDir(agentSpaceRoot: string): string {
  return join(agentSpaceRoot, ...AGENT_SPACE_DOMAIN_SKILLS_DIR);
}

export function runAgentSpaceDirFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const configured =
    env.HANDHELD_RUN_AGENT_SPACE_DIR ||
    env.HANDHELD_AGENT_SPACE ||
    env.HH_AGENT_SPACE;
  return resolve(configured?.trim() || agentSpaceDir(cwd));
}

export function projectAgentSpaceDirFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const configured =
    env.HANDHELD_PROJECT_AGENT_SPACE_DIR ||
    env.HANDHELD_AGENT_SPACE ||
    env.HH_AGENT_SPACE;
  return resolve(configured?.trim() || agentSpaceDir(cwd));
}

export function listDomainSkillFiles(rootDir: string): DomainSkillFile[] {
  const root = resolve(rootDir);
  if (!existsSync(root)) return [];
  const files: DomainSkillFile[] = [];
  walkSkillFiles(root, root, files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function importProjectDomainSkills(input: {
  projectAgentSpaceDir: string;
  runAgentSpaceDir: string;
}): ImportedDomainSkills {
  const projectDomainSkillsDir = domainSkillsDir(input.projectAgentSpaceDir);
  const runDomainSkillsDir = domainSkillsDir(input.runAgentSpaceDir);
  const manifestPath = join(runDomainSkillsDir, AGENT_SPACE_IMPORT_MANIFEST);
  ensureDir(runDomainSkillsDir);

  const imported: DomainSkillFile[] = [];
  if (resolve(projectDomainSkillsDir) === resolve(runDomainSkillsDir)) {
    writePrivateFile(
      manifestPath,
      JSON.stringify(
        { importedAt: new Date().toISOString(), imported, projectDomainSkillsDir, runDomainSkillsDir },
        null,
        2,
      ) + "\n",
    );
    return { imported, manifestPath, projectDomainSkillsDir, runDomainSkillsDir };
  }
  for (const skill of listDomainSkillFiles(projectDomainSkillsDir)) {
    const target = safeJoin(runDomainSkillsDir, skill.path);
    ensureDir(dirname(target));
    assertContainedPath(projectDomainSkillsDir, skill.absolutePath, {
      label: "Project domain skill",
      targetMustExist: true,
    });
    assertContainedPath(runDomainSkillsDir, target, {
      allowMissingTarget: true,
      label: "Run domain skill",
    });
    copyPrivateFile(skill.absolutePath, target);
    imported.push({ absolutePath: target, path: skill.path });
  }

  writePrivateFile(
    manifestPath,
    JSON.stringify(
      {
        importedAt: new Date().toISOString(),
        imported,
        projectDomainSkillsDir,
        runDomainSkillsDir,
      },
      null,
      2,
    ) + "\n",
  );

  return { imported, manifestPath, projectDomainSkillsDir, runDomainSkillsDir };
}

export function readDomainSkill(input: {
  path: string;
  scope?: "project" | "run";
  projectAgentSpaceDir?: string;
  runAgentSpaceDir?: string;
}): { content: string; path: string; absolutePath: string; scope: "project" | "run" } {
  const scope = input.scope ?? "run";
  const root = domainSkillsDir(
    scope === "project"
      ? input.projectAgentSpaceDir ?? projectAgentSpaceDirFromEnv()
      : input.runAgentSpaceDir ?? runAgentSpaceDirFromEnv(),
  );
  const absolutePath = safeJoin(root, normalizeSkillPath(input.path));
  assertContainedPath(root, absolutePath, {
    label: "Domain skill",
    targetMustExist: true,
  });
  return {
    absolutePath,
    content: readPrivateFile(absolutePath, "utf8"),
    path: toPortableRelative(root, absolutePath),
    scope,
  };
}

export function writeRunDomainSkill(input: {
  body: string;
  path?: string;
  packageName?: string;
  runAgentSpaceDir?: string;
  title?: string;
}): DomainSkillFile {
  const root = domainSkillsDir(input.runAgentSpaceDir ?? runAgentSpaceDirFromEnv());
  ensureDir(root);
  const relativePath = normalizeSkillPath(
    input.path ?? skillFilename(input.packageName, input.title),
  );
  const absolutePath = safeJoin(root, relativePath);
  ensureDir(dirname(absolutePath));
  assertContainedPath(root, absolutePath, {
    allowMissingTarget: true,
    label: "Run domain skill",
  });
  writePrivateFile(absolutePath, input.body);
  return { absolutePath, path: toPortableRelative(root, absolutePath) };
}

export function promoteRunDomainSkill(input: {
  path: string;
  overwrite?: boolean;
  projectAgentSpaceDir?: string;
  runAgentSpaceDir?: string;
}): DomainSkillFile {
  const runRoot = domainSkillsDir(input.runAgentSpaceDir ?? runAgentSpaceDirFromEnv());
  const projectRoot = domainSkillsDir(input.projectAgentSpaceDir ?? projectAgentSpaceDirFromEnv());
  const relativePath = normalizeSkillPath(input.path);
  const source = safeJoin(runRoot, relativePath);
  const target = safeJoin(projectRoot, relativePath);
  ensureDir(projectRoot);
  ensureDir(dirname(target));
  assertContainedPath(runRoot, source, {
    label: "Run domain skill",
    targetMustExist: true,
  });
  assertContainedPath(projectRoot, target, {
    allowMissingTarget: true,
    label: "Project domain skill",
  });
  if (!input.overwrite && existsSync(target)) {
    throw new Error(`Project domain skill already exists: ${relativePath}. Pass overwrite true to replace it.`);
  }
  copyPrivateFile(source, target);
  return { absolutePath: target, path: toPortableRelative(projectRoot, target) };
}

function walkSkillFiles(root: string, dir: string, files: DomainSkillFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSkillFiles(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const stat = statSync(absolutePath);
    if (!stat.isFile()) continue;
    const path = toPortableRelative(root, absolutePath);
    if (!isDomainSkillFile(path)) continue;
    files.push({ absolutePath, path });
  }
}

function isDomainSkillFile(path: string): boolean {
  const basename = path.split("/").at(-1)?.toLowerCase();
  return basename !== undefined &&
    basename !== "readme.md" &&
    basename !== "_template.md" &&
    basename !== AGENT_SPACE_IMPORT_MANIFEST.toLowerCase();
}

function normalizeSkillPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) throw new Error("skill path is required");
  return normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
}

function safeJoin(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, relativePath);
  const rel = relative(resolvedRoot, resolved);
  if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new Error(`Skill path escapes agent-space: ${relativePath}`);
  }
  return resolved;
}

function assertContainedPath(
  root: string,
  absolutePath: string,
  opts: {
    allowMissingTarget?: boolean;
    label: string;
    targetMustExist?: boolean;
  },
): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(absolutePath);
  safeJoin(resolvedRoot, relative(resolvedRoot, resolvedPath));
  assertNoSymlinkComponents(resolvedRoot, resolvedPath, {
    allowMissingTarget: opts.allowMissingTarget,
    label: opts.label,
    targetMustExist: opts.targetMustExist,
  });

  const realRoot = realpathSync(resolvedRoot);
  const checkPath = existsSync(resolvedPath) ? resolvedPath : dirname(resolvedPath);
  const realCheck = realpathSync(checkPath);
  if (!isInside(realRoot, realCheck)) {
    throw new Error(`${opts.label} path escapes agent-space: ${relative(resolvedRoot, resolvedPath)}`);
  }
}

function assertNoSymlinkComponents(
  root: string,
  absolutePath: string,
  opts: {
    allowMissingTarget?: boolean;
    label: string;
    targetMustExist?: boolean;
  },
): void {
  try {
    if (lstatSync(root).isSymbolicLink()) {
      throw new Error(`${opts.label} path uses a symlink: ${root}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const relativePath = relative(root, absolutePath);
  const parts = relativePath.split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    const isFinal = index === parts.length - 1;
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && isFinal && opts.allowMissingTarget) return;
      if (code === "ENOENT" && !opts.targetMustExist) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${opts.label} path uses a symlink: ${relative(root, current)}`);
    }
  }
}

function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !rel.split(sep).includes(".."));
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function toPortableRelative(root: string, absolutePath: string): string {
  return relative(resolve(root), resolve(absolutePath)).split(sep).join("/");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "domain-skill";
}

function skillFilename(packageName?: string, title?: string): string {
  const packageSlug = packageName
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${packageSlug || slugify(title || "domain-skill")}.md`;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { mode: DIR_MODE, recursive: true });
  }
}

function readPrivateFile(path: string, encoding: BufferEncoding): string {
  const fd = openSync(path, NOFOLLOW_READ_FLAGS);
  try {
    return readFileSync(fd, encoding);
  } finally {
    closeSync(fd);
  }
}

function copyPrivateFile(source: string, target: string): void {
  const fd = openSync(source, NOFOLLOW_READ_FLAGS);
  try {
    writePrivateFile(target, readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

function writePrivateFile(path: string, data: string | Buffer): void {
  const body = typeof data === "string" && !data.endsWith("\n")
    ? `${data}\n`
    : data;
  const fd = openSync(path, NOFOLLOW_WRITE_FLAGS, FILE_MODE);
  try {
    writeFileSync(fd, body);
  } finally {
    closeSync(fd);
  }
}
