import { existsSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { getBinDir } from "../state.js";

const UNIX_SHIM = `#!/bin/bash
# handheld ADB shim — smart routing for cloud phone commands
# Installed by: handheld shim install | Remove with: handheld shim uninstall

REAL_ADB=$(PATH=$(echo "$PATH" | sed "s|$HOME/.handheld/bin:||g") which adb 2>/dev/null)
[[ -z "$REAL_ADB" ]] && { echo "Error: adb not found" >&2; exit 1; }
ROUTE_BIN=$(command -v handheld-route 2>/dev/null || true)

if [[ "$1" == "connect" && "$2" == handheld:* ]]; then
  handheld connect "\${2#handheld:}" "\${@:3}"; exit $?
fi
if [[ "$1" == "disconnect" && "$2" == handheld:* ]]; then
  handheld disconnect "\${2#handheld:}"; exit $?
fi

SERIAL=""
ROUTE_ARGS=("$@")
if [[ "$1" == "-s" && -n "$2" ]]; then
  SERIAL="$2"
  ROUTE_ARGS=("\${@:3}")
fi

if [[ -n "$ROUTE_BIN" ]]; then
  if "$ROUTE_BIN" --check "$SERIAL" "\${ROUTE_ARGS[@]}" >/dev/null 2>&1; then
    exec "$ROUTE_BIN" --exec "$SERIAL" "\${ROUTE_ARGS[@]}"
  fi
elif handheld _route --check "$SERIAL" "\${ROUTE_ARGS[@]}" >/dev/null 2>&1; then
  exec handheld _route --exec "$SERIAL" "\${ROUTE_ARGS[@]}"
fi

"$REAL_ADB" "$@"
`;

const WIN_SHIM = `@echo off
setlocal enabledelayedexpansion
REM handheld ADB shim for Windows
REM Installed by: handheld shim install | Remove with: handheld shim uninstall

set "ROUTE_BIN="
for /f "tokens=*" %%i in ('where handheld-route 2^>nul') do (
  set "ROUTE_BIN=%%i"
  goto route_bin_found
)
:route_bin_found

if "%1"=="connect" (
  echo %2 | findstr /B "handheld:" >nul 2>nul
  if not errorlevel 1 (
    set "DEV=%2"
    set "DEV=!DEV:handheld:=!"
    handheld connect !DEV! %3 %4 %5 %6 %7 %8 %9
    exit /b !errorlevel!
  )
)
if "%1"=="disconnect" (
  echo %2 | findstr /B "handheld:" >nul 2>nul
  if not errorlevel 1 (
    set "DEV=%2"
    set "DEV=!DEV:handheld:=!"
    handheld disconnect !DEV!
    exit /b !errorlevel!
  )
)

set "SERIAL="
if "%1"=="-s" (
  set "SERIAL=%2"
  shift
  shift
)

if defined ROUTE_BIN (
  "%ROUTE_BIN%" --check "!SERIAL!" %* >nul 2>nul
  if not errorlevel 1 (
    "%ROUTE_BIN%" --exec "!SERIAL!" %*
    exit /b !errorlevel!
  )
) else (
  handheld _route --check "!SERIAL!" %* >nul 2>nul
  if not errorlevel 1 (
    handheld _route --exec "!SERIAL!" %*
    exit /b !errorlevel!
  )
)

REM Find real adb (skip our shim dir)
for /f "tokens=*" %%i in ('where adb 2^>nul ^| findstr /V "\\.handheld\\\\bin"') do (
  "%%i" %*
  exit /b !errorlevel!
)
echo Error: adb not found >&2
exit /b 1
`;

function getRouteCliPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "route-cli.js");
}

export function registerShimCommand(program: Command): void {
  const shim = program
    .command("shim", { hidden: true })
    .description("manage the ADB shim that transparently routes `adb` to cloud phones (subcommands: install, uninstall, status)")
    .addHelpText(
      "after",
      `
The shim wraps \`adb\` so existing scripts work against cloud phones unchanged:
\`adb connect handheld:<device-id>\` and routable commands go through the relay
fast path; everything else falls through to the real adb.

Subcommands:
  handheld shim install      # write the shim to ~/.handheld/bin/ (then add it to PATH, ahead of real adb)
  handheld shim uninstall    # remove the shim
  handheld shim status       # report whether it is installed and active (on PATH)

Caveats:
  - ~/.handheld/bin must come BEFORE the real adb on PATH; \`install\` prints the exact line to add.
  - The real adb must still be installed — the shim shells out to it for non-routable commands.
  - Routing only helps once a device is attached (\`handheld connect\`); otherwise commands just pass through.`
    );

  shim
    .command("install")
    .description("install the ADB shim into ~/.handheld/bin/ (prints the PATH line to add)")
    .action(() => {
      const binDir = getBinDir();
      const isWin = platform() === "win32";
      const routeCliPath = getRouteCliPath();

      if (isWin) {
        const shimPath = join(binDir, "adb.cmd");
        const routeShimPath = join(binDir, "handheld-route.cmd");
        writeFileSync(shimPath, WIN_SHIM);
        writeFileSync(
          routeShimPath,
          `@echo off\r\nnode "${routeCliPath}" %*\r\n`
        );
        console.log(`Shim installed: ${shimPath}`);
        console.log(`Route helper installed: ${routeShimPath}`);
      } else {
        const shimPath = join(binDir, "adb");
        const routeShimPath = join(binDir, "handheld-route");
        writeFileSync(shimPath, UNIX_SHIM);
        writeFileSync(
          routeShimPath,
          `#!/bin/bash\nexec node "${routeCliPath}" "$@"\n`
        );
        chmodSync(shimPath, 0o755);
        chmodSync(routeShimPath, 0o755);
        console.log(`Shim installed: ${shimPath}`);
        console.log(`Route helper installed: ${routeShimPath}`);
      }

      const pathDirs = (process.env.PATH ?? "").split(isWin ? ";" : ":");
      if (!pathDirs.includes(binDir)) {
        if (isWin) {
          console.log(`\nAdd to PATH:\n  setx PATH "%USERPROFILE%\\.handheld\\bin;%PATH%"`);
        } else {
          const rc = (process.env.SHELL ?? "").includes("zsh")
            ? join(homedir(), ".zshrc")
            : join(homedir(), ".bashrc");
          console.log(`\nAdd to PATH:\n  echo 'export PATH="$HOME/.handheld/bin:$PATH"' >> ${rc} && source ${rc}`);
        }
      } else {
        console.log("~/.handheld/bin already in PATH.");
      }

      console.log(`\nUsage:\n  adb connect handheld:<device-id>`);
    });

  shim
    .command("uninstall")
    .description("remove the ADB shim from ~/.handheld/bin/")
    .action(() => {
      const binDir = getBinDir();
      for (const name of ["adb", "adb.cmd"]) {
        const p = join(binDir, name);
        if (existsSync(p)) { unlinkSync(p); console.log(`Removed ${p}`); }
      }
      for (const name of ["handheld-route", "handheld-route.cmd"]) {
        const p = join(binDir, name);
        if (existsSync(p)) { unlinkSync(p); console.log(`Removed ${p}`); }
      }
    });

  shim
    .command("status")
    .description("report whether the ADB shim is installed and active (on PATH)")
    .action(() => {
      const binDir = getBinDir();
      const isWin = platform() === "win32";
      const shimFile = isWin ? "adb.cmd" : "adb";
      const installed = existsSync(join(binDir, shimFile));
      const pathDirs = (process.env.PATH ?? "").split(isWin ? ";" : ":");
      const inPath = pathDirs.includes(binDir);
      console.log(`Installed: ${installed}\nIn PATH:   ${inPath}\nActive:    ${installed && inPath}`);
    });
}
