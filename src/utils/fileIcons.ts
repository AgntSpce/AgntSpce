// File-type icon + color mapping for the explorer tree.
//
// IMPORTANT: values must be glyph names that exist in the installed
// @vscode/codicons build (see node_modules/@vscode/codicons/dist/codicon.css).
// Brand icons (react, typescript, html, go, …) do NOT ship with codicons —
// unknown names render blank, so everything here resolves to real glyphs:
// generic buckets (file-code, file-media, …) plus the few brand glyphs that
// do exist (python, ruby, …).
const EXT_ICON_MAP: Record<string, string> = {
  // Code (generic bucket — no per-language brand glyphs in codicons)
  js: 'file-code', jsx: 'file-code', mjs: 'file-code', cjs: 'file-code',
  ts: 'file-code', tsx: 'file-code', mts: 'file-code', cts: 'file-code',
  c: 'file-code', h: 'file-code', cc: 'file-code', cpp: 'file-code',
  cxx: 'file-code', hpp: 'file-code', hh: 'file-code', cs: 'file-code',
  java: 'file-code', kt: 'file-code', kts: 'file-code', scala: 'file-code',
  sc: 'file-code', go: 'file-code', rs: 'file-code', php: 'file-code',
  swift: 'file-code', m: 'file-code', mm: 'file-code', pl: 'file-code',
  pm: 'file-code', lua: 'file-code', r: 'file-code', jl: 'file-code',
  dart: 'file-code', elm: 'file-code', ex: 'file-code', exs: 'file-code',
  erl: 'file-code', hrl: 'file-code', clj: 'file-code', cljs: 'file-code',
  cljc: 'file-code', hs: 'file-code', ml: 'file-code', mli: 'file-code',
  fs: 'file-code', fsi: 'file-code', fsx: 'file-code', vb: 'file-code',
  v: 'file-code', pas: 'file-code', pp: 'file-code', asm: 'file-code',
  s: 'file-code', zig: 'file-code', nim: 'file-code', cr: 'file-code',
  groovy: 'file-code', gvy: 'file-code', gradle: 'file-code',
  proto: 'file-code', tf: 'file-code', tfvars: 'file-code',
  // Markup / components
  html: 'browser', htm: 'browser',
  xml: 'code', xsd: 'code', xsl: 'code', xslt: 'code', wsdl: 'code',
  rss: 'code', atom: 'code',
  vue: 'code', svelte: 'code', astro: 'code',
  ejs: 'code', hbs: 'code', mustache: 'code', liquid: 'code',
  njk: 'code', twig: 'code', j2: 'code', jinja: 'code',
  // Styles
  css: 'paintcan', scss: 'paintcan', sass: 'paintcan', less: 'paintcan',
  styl: 'paintcan', stylus: 'paintcan',
  // Scripts (brand glyphs where they exist, terminal buckets otherwise)
  py: 'python', pyw: 'python', pyi: 'python',
  rb: 'ruby', erb: 'ruby', gemspec: 'ruby',
  sh: 'terminal-bash', bash: 'terminal-bash', zsh: 'terminal-bash',
  fish: 'terminal-bash', ksh: 'terminal-bash',
  ps1: 'terminal-powershell', psm1: 'terminal-powershell', psd1: 'terminal-powershell',
  bat: 'terminal-cmd', cmd: 'terminal-cmd',
  // Data
  json: 'json', jsonc: 'json', json5: 'json', jsonl: 'json', ndjson: 'json',
  yaml: 'gear', yml: 'gear',
  toml: 'gear', ini: 'gear', cfg: 'gear', conf: 'gear', config: 'gear',
  properties: 'gear', editorconfig: 'gear', browserslist: 'gear',
  npmrc: 'gear', yarnrc: 'gear',
  csv: 'table', tsv: 'table', xls: 'table', xlsx: 'table', ods: 'table',
  db: 'database', sqlite: 'database', sqlite3: 'database', db3: 'database',
  sql: 'database',
  log: 'output',
  lock: 'lock',
  env: 'key',
  graphql: 'globe', gql: 'globe',
  http: 'globe', rest: 'globe',
  // Docs & prose
  md: 'markdown', mdx: 'markdown', markdown: 'markdown', mkd: 'markdown',
  txt: 'file-text', text: 'file-text', rst: 'file-text',
  adoc: 'file-text', asciidoc: 'file-text', tex: 'file-text', bib: 'file-text',
  doc: 'file-text', docx: 'file-text', odt: 'file-text', rtf: 'file-text',
  ppt: 'file-text', pptx: 'file-text', odp: 'file-text',
  pdf: 'file-pdf',
  ipynb: 'notebook',
  // Images / video / audio
  png: 'file-media', jpg: 'file-media', jpeg: 'file-media', gif: 'file-media',
  svg: 'file-media', ico: 'file-media', webp: 'file-media', bmp: 'file-media',
  avif: 'file-media', tif: 'file-media', tiff: 'file-media', heic: 'file-media',
  psd: 'file-media', ai: 'file-media', eps: 'file-media', sketch: 'file-media',
  mp4: 'file-media', mov: 'file-media', avi: 'file-media', mkv: 'file-media',
  webm: 'file-media', m4v: 'file-media', ogv: 'file-media',
  mp3: 'music', wav: 'music', ogg: 'music', oga: 'music', flac: 'music',
  aac: 'music', m4a: 'music', opus: 'music',
  // Archives
  zip: 'file-zip',
  tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive',
  xz: 'archive', rar: 'archive', '7z': 'archive', deb: 'archive',
  rpm: 'archive', dmg: 'archive', iso: 'archive',
  jar: 'archive', war: 'archive', ear: 'archive',
  // Fonts
  ttf: 'text-size', otf: 'text-size', woff: 'text-size', woff2: 'text-size',
  eot: 'text-size',
  // Binaries
  exe: 'file-binary', msi: 'file-binary', bin: 'file-binary',
  o: 'file-binary', obj: 'file-binary', a: 'file-binary', so: 'file-binary',
  dll: 'file-binary', dylib: 'file-binary', lib: 'file-binary',
  class: 'file-binary', pyc: 'file-binary', wasm: 'file-binary',
  // Certificates
  pem: 'shield', crt: 'shield', cer: 'shield', der: 'shield',
  p12: 'shield', pfx: 'shield', key: 'shield',
  // Git helpers
  gitignore: 'git-branch', gitattributes: 'git-branch',
  gitmodules: 'git-branch', gitkeep: 'git-branch',
}

// Exact filenames (lowercased, without path) that beat extension lookup.
const NAME_ICON_MAP: Record<string, string> = {
  dockerfile: 'layers',
  makefile: 'tools',
  rakefile: 'ruby',
  gemfile: 'ruby',
  license: 'law',
  licence: 'law',
  readme: 'book',
  changelog: 'book',
}

// Prefix rules for dotted variants (Dockerfile.dev, .env.local, …).
function iconByNamePattern(lower: string): string | null {
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'layers'
  if (lower === 'makefile' || lower.startsWith('makefile.')) return 'tools'
  if (lower === '.env' || lower.startsWith('.env.')) return 'key'
  if (lower === 'license' || lower.startsWith('license.') || lower === 'licence' || lower.startsWith('licence.')) return 'law'
  if (lower === 'readme' || lower.startsWith('readme.')) return 'book'
  return null
}

// Brand-ish accent colors (mid-tones legible on dark AND light themes).
// Extensions without an entry stay monochrome (inherit tree text color).
const COLOR_MAP: Record<string, string> = {
  js: '#c2a134', jsx: '#c2a134', mjs: '#c2a134', cjs: '#c2a134',
  ts: '#4b9fc4', tsx: '#4b9fc4', mts: '#4b9fc4', cts: '#4b9fc4',
  html: '#e37933', htm: '#e37933',
  css: '#5aa9e6', scss: '#5aa9e6', sass: '#5aa9e6', less: '#5aa9e6',
  json: '#c2a134', jsonc: '#c2a134', json5: '#c2a134',
  md: '#519aba', mdx: '#519aba', markdown: '#519aba',
  py: '#4b8bbe', pyw: '#4b8bbe',
  rb: '#cc342d',
  go: '#00a6c6',
  rs: '#b4552d',
  java: '#e76f00',
  php: '#777bb4',
  swift: '#f05138',
  kt: '#7f52ff',
  dart: '#0175c2',
  sh: '#4c9a52', bash: '#4c9a52', zsh: '#4c9a52', fish: '#4c9a52',
  sql: '#cf8b2d', db: '#cf8b2d', sqlite: '#cf8b2d', sqlite3: '#cf8b2d',
  csv: '#4b8bbe', tsv: '#4b8bbe', xls: '#4b8bbe', xlsx: '#4b8bbe',
  png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4', gif: '#a074c4',
  svg: '#a074c4', ico: '#a074c4', webp: '#a074c4',
  mp3: '#c678dd', wav: '#c678dd', ogg: '#c678dd', flac: '#c678dd',
  pdf: '#e05252',
  zip: '#8b949e', tar: '#8b949e', gz: '#8b949e',
  yaml: '#8b949e', yml: '#8b949e', toml: '#8b949e',
  lock: '#8b949e',
  env: '#cfa64d',
  graphql: '#e535ab', gql: '#e535ab',
  ipynb: '#dd6f2d',
  gitignore: '#f05032', gitattributes: '#f05032',
}

function extOf(fileName: string): string {
  const base = fileName.split('/').pop() || fileName
  if (!base.includes('.')) return ''
  return base.split('.').pop()?.toLowerCase() ?? ''
}

export function getFileIconClass(fileName: string): string {
  const lower = (fileName.split('/').pop() || fileName).toLowerCase()
  const byPattern = iconByNamePattern(lower)
  if (byPattern) return byPattern
  const exact = NAME_ICON_MAP[lower]
  if (exact) return exact
  return EXT_ICON_MAP[extOf(fileName)] || 'file'
}

export function getFileIconColor(fileName: string): string | undefined {
  const lower = (fileName.split('/').pop() || fileName).toLowerCase()
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return '#519aba'
  return COLOR_MAP[extOf(fileName)]
}

// ── Devicon brand marks (public/img/devicon/*.svg) ─────────────────────
// Real technology logos, used in place of the generic codicon above. Every
// variant here was checked to be legible on BOTH dark and light themes
// (no black-only / white-only / wordmark-only marks).
const DEVICON_EXT_MAP: Record<string, string> = {
  js: 'javascript.svg', mjs: 'javascript.svg', cjs: 'javascript.svg',
  ts: 'typescript.svg', mts: 'typescript.svg', cts: 'typescript.svg',
  jsx: 'react.svg', tsx: 'react.svg',
  py: 'python.svg', pyw: 'python.svg',
  rb: 'ruby.svg', erb: 'ruby.svg',
  go: 'go.svg',
  java: 'java.svg',
  kt: 'kotlin.svg', kts: 'kotlin.svg',
  scala: 'scala.svg',
  c: 'c.svg', h: 'c.svg',
  cpp: 'cplusplus.svg', hpp: 'cplusplus.svg', cc: 'cplusplus.svg',
  cxx: 'cplusplus.svg', hh: 'cplusplus.svg',
  cs: 'csharp.svg',
  php: 'php.svg',
  swift: 'swift.svg',
  dart: 'dart.svg',
  lua: 'lua.svg',
  r: 'r.svg',
  pl: 'perl.svg', pm: 'perl.svg',
  hs: 'haskell.svg',
  ex: 'elixir.svg', exs: 'elixir.svg',
  elm: 'elm.svg',
  erl: 'erlang.svg', hrl: 'erlang.svg',
  clj: 'clojure.svg', cljs: 'clojure.svg', cljc: 'clojure.svg',
  ml: 'ocaml.svg', mli: 'ocaml.svg',
  jl: 'julia.svg',
  zig: 'zig.svg',
  f: 'fortran.svg', f90: 'fortran.svg', for: 'fortran.svg',
  fs: 'fsharp.svg', fsi: 'fsharp.svg', fsx: 'fsharp.svg',
  vb: 'visualbasic.svg',
  mm: 'objectivec.svg',
  vy: 'vyper.svg',
  sh: 'bash.svg', bash: 'bash.svg', zsh: 'bash.svg', fish: 'bash.svg',
  ksh: 'bash.svg',
  ps1: 'powershell.svg', psm1: 'powershell.svg', psd1: 'powershell.svg',
  vim: 'vim.svg', vimrc: 'vim.svg',
  html: 'html5.svg', htm: 'html5.svg',
  css: 'css3.svg',
  scss: 'sass.svg', sass: 'sass.svg',
  vue: 'vuejs.svg',
  svelte: 'svelte.svg',
  astro: 'astro.svg',
  xml: 'xml.svg', xsd: 'xml.svg', xsl: 'xml.svg', xslt: 'xml.svg',
  wsdl: 'xml.svg', rss: 'xml.svg', atom: 'xml.svg',
  graphql: 'graphql.svg', gql: 'graphql.svg',
  json: 'json.svg', jsonc: 'json.svg', json5: 'json.svg',
  jsonl: 'json.svg', ndjson: 'json.svg',
  yaml: 'yaml.svg', yml: 'yaml.svg',
  db: 'sqlite.svg', sqlite: 'sqlite.svg', sqlite3: 'sqlite.svg',
  db3: 'sqlite.svg',
  ipynb: 'jupyter.svg',
  tf: 'terraform.svg', tfvars: 'terraform.svg',
  bzl: 'bazel.svg',
  gitignore: 'git.svg', gitattributes: 'git.svg',
  gitmodules: 'git.svg', gitkeep: 'git.svg',
}

// Exact filenames (lowercased) that resolve to a devicon.
const DEVICON_NAME_MAP: Record<string, string> = {
  'package.json': 'npm.svg',
  'yarn.lock': 'yarn.svg',
  gemfile: 'ruby.svg',
  rakefile: 'ruby.svg',
  'cmakelists.txt': 'cmake.svg',
  '.eslintrc': 'eslint.svg',
}

function deviconByNamePattern(lower: string): string | null {
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'docker.svg'
  if (lower === '.eslintrc' || lower.startsWith('.eslintrc.')) return 'eslint.svg'
  return null
}

/** Devicon SVG filename for the file, or null to use the codicon fallback. */
export function getFileDevicon(fileName: string): string | null {
  const lower = (fileName.split('/').pop() || fileName).toLowerCase()
  return deviconByNamePattern(lower) ?? DEVICON_NAME_MAP[lower] ?? DEVICON_EXT_MAP[extOf(fileName)] ?? null
}
