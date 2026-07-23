// Metro config for consuming the workspace `@claudecode/protocol` package, whose source is raw `.ts`
// (no build step). Metro's Babel transformer already handles `.ts`/`.tsx` and the package's explicit
// `./frame.ts`-style specifiers via its `exports` map (enabled by default on SDK 57), so no extra
// transform rule is needed, only the monorepo watch/resolve wiring below.
//
// Hard constraint: the app must import ONLY `@claudecode/protocol` (the portable `.` entry), never
// `@claudecode/protocol/node` (that pulls `node:crypto` and Metro cannot bundle it). The crypto is
// supplied on-device by src/core/crypto (pure-JS @noble), verified byte-compatible with the daemon.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
