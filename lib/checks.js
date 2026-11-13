/**
 * DSH 插件静态检查核心
 *
 * 为什么做这个：
 *   2026-11-10 我自己写的插件在沙箱里 install_failed，
 *   真实错误是 `cannot get property "config" without inject`，
 *   但沙箱只返回最后一行日志，完全看不出原因。
 *
 *   这一类错误完全可以静态检测出来，不用等沙箱。
 *
 * 检查分七层：
 *   L1   manifest  —— package.json 的必填字段
 *   L1.5 packaging —— npm 打包内容（.bak 会不会被带出去、包大小异常）
 *   L2   patch     —— cordis.patch.yml 的语法与结构
 *   L2.5 output    —— 工具 output 的 JSON Schema 形状（required 位置）
 *   L3   code      —— lib/ 下的语法与 ctx 访问契约
 *   L3.5 inject    —— inject 里的服务名合法性（不能写 config）
 *   L4   deps      —— 依赖里有没有会让别人装不上的东西
 *
 * 每条结果：
 *   { level: 'fail'|'warn'|'pass', layer, id, title, detail, fix }
 *
 * ══════════════════════════════════════════════════════════════
 *  2026-11-10 教训（这三条是新增检查的理由）：
 *
 *  1. output.schema 里写 required: true
 *     → JsonSchemaError: schema.properties.text.required is not supported
 *     → 整个 entry 不激活。静态检查以前完全没查 output 内容。
 *
 *  2. inject = ["tools", "skills", "config"]
 *     → pending (waiting for service: config)，entry 永远卡住。
 *     → config 不是可注入服务！以前的 known 集合里错误地包含了它。
 *
 *  3. files: ["lib"] 会把 lib/index.js.bak.* 一起打包
 *     → 包体积从 14.6 KB 涨到 108 KB，还把备份文件暴露出去。
 * ══════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════
//  常量
// ═══════════════════════════════════════════════════════════════

/**
 * DSH 允许在 inject 里声明的服务。
 *
 * 注意：config 不在这里。插件配置必须用 apply(ctx, config) 的第二参数取。
 * 把 config 写进 inject 会让 entry 永远 pending。
 */
const VALID_INJECT_SERVICES = new Set([
  "tools", "systemPrompt", "skills", "fs", "llm", "web", "session", "shell",
]);

/**
 * Cordis 运行时自身提供的属性，不需要 inject。
 * 这些不是「服务」，是 ctx 的基础能力。
 */
const BUILTIN_CTX_PROPS = new Set([
  "on", "emit", "logger", "plugin", "scope", "root", "effect",
  "set", "get", "inject", "config",
]);

/**
 * 写进 inject 会出问题的名字 → 原因与修法
 */
const FORBIDDEN_INJECT = {
  config: {
    why: "config 不是可注入服务。写进 inject 后 entry 会永远卡在 " +
         "pending (waiting for service: config)。",
    fix: "从 inject 里删掉 \"config\"。插件配置用 apply 的第二参数取：\n" +
         "  export function apply(ctx, config) {\n" +
         "    const cfg = config || {};\n" +
         "  }",
  },
};

// ═══════════════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════════════

function r(level, layer, id, title, detail, fix) {
  return { level, layer, id, title, detail: detail || "", fix: fix || "" };
}

/**
 * 剥掉 JS 注释，并把字符串**内容**替换成空格（保留引号和长度）。
 *
 * 2026-11-10 实测两个假阳性：
 *   1. scaffold 模板的注释里写了「不要读 ctx.config」→ 被当成真代码
 *   2. EXPLAIN 里的字符串内容 "output.schema": { ... } → 被当成 output 声明
 *
 * 只剥注释不够，因为字符串内容里的示例代码还是会被正则匹配到。
 * 把字符串内容换成空格，长度不变，这样索引对齐、正则也不会误命中。
 */
function stripComments(src) {
  return _strip(src, true);
}

/**
 * 只剥注释，保留字符串内容。
 * 用于提取 inject 服务名这类「必须读字符串值」的场景。
 */
function stripCommentsOnly(src) {
  return _strip(src, false);
}

function _strip(src, maskStrings) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // 正则字面量（2026-11-13：正则里的 /* */ 与引号会把后面的代码吞掉）
    if (c === "/" && c2 !== "/" && c2 !== "*") {
      let j = i - 1;
      while (j >= 0 && (src[j] === " " || src[j] === "\t" || src[j] === "\n")) j--;
      const prev = j >= 0 ? src[j] : "";
      const prev2 = j >= 1 ? src[j - 1] : "";
      const regexCtx = prev === "" || "(,=:[!&|?{};".includes(prev) ||
        (prev2 === "w" && src.slice(Math.max(0, j - 6), j + 1) === "return");
      if (regexCtx) {
        out += " ";
        i++;
        let inClass = false;
        while (i < n) {
          const ch = src[i];
          if (ch === "\\") { out += "  "; i += 2; continue; }
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) { i++; break; }
          else if (ch === "\n") break;
          out += " ";
          i++;
        }
        continue;
      }
    }
    // 行注释
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    // 块注释
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += (src[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) { out += "  "; i += 2; }
      continue;
    }
    // 字符串
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += q;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          out += maskStrings ? "  " : (src[i] + (src[i + 1] || ""));
          i += 2;
          continue;
        }
        if (src[i] === q) {
          out += q;
          i++;
          break;
        }
        out += maskStrings ? (src[i] === "\n" ? "\n" : " ") : src[i];
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 极简 YAML 形状检查（不引依赖，只看插件需要的子集） */
function parsePatchShape(text) {
  const out = { isArray: false, inserts: [], entries: [], unquotedAt: [] };
  const lines = text.split(/\r?\n/);

  let firstContent = "";
  for (const ln of lines) {
    const t = ln.trim();
    if (!t || t.startsWith("#")) continue;
    firstContent = t;
    break;
  }
  out.isArray = firstContent.startsWith("-");

  let inInsert = false;
  let insertIndent = -1;
  let cur = null;

  lines.forEach((raw, i) => {
    const ln = raw.replace(/\t/g, "  ");
    const t = ln.trim();
    if (!t || t.startsWith("#")) return;

    const indent = ln.length - ln.trimStart().length;

    if (/^-\s*insert\s*:/.test(t)) {
      inInsert = true;
      insertIndent = indent;
      out.inserts.push(i + 1);
      cur = null;
      return;
    }

    if (inInsert && indent <= insertIndent && /^-\s*\w/.test(t)) {
      inInsert = false;
      cur = null;
    }

    if (inInsert) {
      const m = /^-\s*(\w+)\s*:\s*(.*)$/.exec(t);
      if (m && indent > insertIndent) {
        cur = { line: i + 1 };
        out.entries.push(cur);
        cur[m[1]] = m[2].trim();
        return;
      }
      const kv = /^(\w+)\s*:\s*(.*)$/.exec(t);
      if (kv && cur) {
        cur[kv[1]] = kv[2].trim();
        if (/^@/.test(kv[2].trim())) {
          out.unquotedAt.push({ line: i + 1, key: kv[1], value: kv[2].trim() });
        }
      }
    }
  });

  return out;
}

/**
 * 挑出「入口文件」——语义检查只看这些。
 *
 * 2026-11-10 实测两个坑：
 *   1. 把 lib 下所有文件拼在一起分析，strip 函数的引号配对会跨文件错乱
 *      （merged 分析出 injectServices=[]，但单独分析 index.js 就正常）
 *   2. skills.js 里有指南文本，包含示例代码 "export const inject = [\"tools\"]"
 *      → 被当成真代码，提取出假服务名
 *
 * 所以：语义项（inject / name / apply / output）只从入口文件读。
 * 判定标准：含 export function apply 的文件，或 pkg.main 指向的文件。
 */
function pickEntryFiles(files, pkg) {
  if (!files || !files.length) return [];
  const byApply = files.filter((f) =>
    /export\s+(async\s+)?function\s+apply\s*\(/.test(stripComments(f.text)));
  if (byApply.length) return byApply;

  const main = pkg && (pkg.main || (typeof pkg.exports === "string" ? pkg.exports : null));
  if (main) {
    const norm = String(main).replace(/^\.\//, "").replace(/\\/g, "/");
    const hit = files.find((f) => f.path === norm || f.path.endsWith("/" + norm));
    if (hit) return [hit];
  }
  return files.slice(0, 1);
}

/** 粗粒度提取 ESM 里的 ctx.xxx 访问与服务声明 */
function analyzeCode(rawText) {
  // 两份文本，用途不同：
  //   text  —— 字符串已屏蔽，用于找 ctx.X / output / register（不会被示例代码误导）
  //   raw   —— 字符串保留，用于读 inject 的服务名（服务名本身就在字符串里）
  const text = stripComments(rawText);
  const raw = stripCommentsOnly(rawText);
  const out = {
    ctxAccess: new Set(),
    injectServices: [],
    hasApply: false,
    hasApplyWithConfig: false,
    hasName: false,
    isEsm: false,
    imports: [],
    absolutePaths: [],
    outputDecls: [],
    toolRegisters: [],
    readsCtxConfig: false,
  };

  // inject 声明（用 raw：服务名在字符串里，屏蔽了就看不到）
  const inj = /export\s+const\s+inject\s*=\s*(\[[^\]]*\]|\{[^}]*\})/s.exec(raw);
  if (inj) {
    const body = inj[1];
    const names = body.match(/["']([A-Za-z_$][\w$]*)["']/g) || [];
    out.injectServices = names.map((s) => s.replace(/["']/g, ""));
  }

  out.hasApply = /export\s+(async\s+)?function\s+apply\s*\(/.test(text);
  out.hasApplyWithConfig = /export\s+(async\s+)?function\s+apply\s*\(\s*\w+\s*,\s*\w+\s*\)/.test(text);
  out.hasName = /export\s+const\s+name\s*=/.test(text);
  out.isEsm = /^\s*(import|export)\s/m.test(text);
  out.readsCtxConfig = /\bctx\s*\.\s*config\b/.test(text);

  // ctx.<prop> 访问
  const re = /\bctx\s*\.\s*([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(text))) {
    out.ctxAccess.add(m[1]);
  }

  // import 语句
  const ire = /import\s+[^"']*["']([^"']+)["']/g;
  while ((m = ire.exec(text))) {
    out.imports.push(m[1]);
  }

  // 硬编码绝对路径
  const ap = /["'`](\/(?:root|home|var|opt|Users)\/[^"'`\s]+)["'`]/g;
  while ((m = ap.exec(text))) {
    out.absolutePaths.push(m[1]);
  }

  // ── output 声明收集（新增）──
  // 匹配 const XXX_OUTPUT = { ... } 或 output: { ... } 内联
  const outRe = /(?:const\s+(\w*OUTPUT\w*)\s*=\s*\{|output\s*:\s*\{)/g;
  while ((m = outRe.exec(text))) {
    const start = m.index + m[0].length;
    // 找配对的右花括号
    let depth = 1;
    let i = start;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    const body = text.slice(start, i - 1);
    // 只在 schema 部分找 type: "text"。
    // render 里合法地会有 { type: "text", text: ... }，不能误报。
    const renderIdx = body.search(/\brender\s*:/);
    const schemaPart = renderIdx >= 0 ? body.slice(0, renderIdx) : body;

    out.outputDecls.push({
      name: m[1] || "(inline)",
      index: m.index,
      body,
      hasSchema: /schema\s*:/.test(body),
      hasRender: /render\s*:/.test(body),
      // 检测 schema 里 required 是否写在属性内
      badRequired:
        /properties\s*:\s*\{[^}]*\{[^}]*required\s*:\s*true[^}]*\}/s.test(schemaPart) ||
        /required\s*:\s*true/.test(schemaPart),
      // 检测 required 是否在对象级
      goodRequired: /required\s*:\s*\[/.test(schemaPart),
      // 检测 schema 本身被写成了 { type: "text" }（裸类型）
      badTypeText: /^\s*\{?\s*type\s*:\s*["']text["']\s*\}?\s*$/.test(body.trim()),
    });
  }

  // 收集 ctx.tools.register({...}) 的 tool 名
  const regRe = /ctx\s*\.\s*tools\s*\.\s*register\s*\(\s*\{/g;
  while ((m = regRe.exec(text))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    const body = text.slice(start, i - 1);
    const nm = /name\s*:\s*["']([^"']+)["']/.exec(body);
    out.toolRegisters.push({
      name: nm ? nm[1] : "(unknown)",
      body,
      hasOutput: /output\s*:/.test(body),
    });
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════
//  L1 manifest
// ═══════════════════════════════════════════════════════════════

export function checkManifest(pkg) {
  const out = [];
  if (!pkg) {
    out.push(r("fail", "L1", "manifest.missing", "读不到 package.json",
      "目标目录下没有 package.json", "确认路径指向插件根目录"));
    return out;
  }

  out.push(pkg.name
    ? r("pass", "L1", "manifest.name", "name", pkg.name)
    : r("fail", "L1", "manifest.name", "缺 name", "", "package.json 加 \"name\""));

  out.push(pkg.version
    ? r("pass", "L1", "manifest.version", "version", pkg.version)
    : r("fail", "L1", "manifest.version", "缺 version", "", "package.json 加 \"version\""));

  const patch = pkg.dsh?.bundle?.patch;
  if (!patch) {
    out.push(r("fail", "L1", "manifest.patch",
      "缺 dsh.bundle.patch", "没有这个字段就不是 DSH 插件",
      "加 \"dsh\": { \"bundle\": { \"patch\": \"./cordis.patch.yml\" } }"));
  } else {
    out.push(r("pass", "L1", "manifest.patch", "dsh.bundle.patch", patch));
  }

  if (!pkg.main && !pkg.exports) {
    out.push(r("fail", "L1", "manifest.entry", "缺 main 或 exports",
      "", "加 \"main\": \"lib/index.js\""));
  } else {
    out.push(r("pass", "L1", "manifest.entry", "代码入口",
      pkg.main || JSON.stringify(pkg.exports)));
  }

  if (patch) {
    const files = (pkg.files || []).map((f) => String(f).replace(/^\.\//, ""));
    const p = String(patch).replace(/^\.\//, "");
    if (files.length && !files.includes(p)) {
      out.push(r("fail", "L1", "manifest.files.patch",
        "files 里没有 patch 文件", "本地能装，npm 上装不上",
        `"files" 加上 "${p}"`));
    } else {
      out.push(r("pass", "L1", "manifest.files.patch", "patch 在 files 里", p));
    }
    if (files.length && !files.some((f) => f.startsWith("lib"))) {
      out.push(r("fail", "L1", "manifest.files.lib",
        "files 里没有 lib", "", "\"files\" 加 \"lib\""));
    }
  }

  const eng = pkg.engines?.dsh;
  if (!eng) {
    out.push(r("warn", "L1", "manifest.engines",
      "没写 engines.dsh", "安装时无法判定版本兼容",
      "加 \"engines\": { \"dsh\": \">=0.2.0-rc.2\" }"));
  } else if (/<|<=/.test(eng)) {
    out.push(r("fail", "L1", "manifest.engines.upper",
      "engines.dsh 写了上界", eng,
      "只写下界。上界会让新版本一发布你的插件就装不上"));
  } else {
    out.push(r("pass", "L1", "manifest.engines", "engines.dsh", eng));
  }

  if (pkg.type !== "module" && pkg.type !== "commonjs") {
    out.push(r("warn", "L1", "manifest.type", "type 未声明",
      "", "建议加 \"type\": \"module\""));
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════
//  L1.5 packaging（新增）
// ═══════════════════════════════════════════════════════════════

/**
 * 检查 npm 打包内容。
 * files 里写 "lib" 会把 lib 下所有文件都带上，包括 .bak / .log / .tmp。
 */
export function checkPackaging(pkg, files) {
  const out = [];
  if (!pkg) return out;

  const declared = (pkg.files || []).map((f) => String(f).replace(/^\.\//, ""));

  // 1. files 是否覆盖 lib
  const hasLib = declared.some((f) => f.startsWith("lib"));
  out.push(hasLib
    ? r("pass", "L1.5", "pack.files.lib", "files 覆盖 lib")
    : r("warn", "L1.5", "pack.files.lib", "files 里没有 lib",
      "", "\"files\": [\"lib\", \"cordis.patch.yml\"]"));

  // 2. 检查 lib 下有没有会被误打包的临时文件
  const junkExts = [".bak", ".log", ".tmp", ".orig", ".rej", ".swp", ".old"];
  const junk = (files || []).filter((f) => {
    const p = f.path || "";
    return junkExts.some((e) => p.includes(e));
  });

  if (junk.length) {
    const sample = junk.slice(0, 5).map((f) => f.path).join(", ");
    out.push(r("fail", "L1.5", "pack.junk",
      "有临时/备份文件会被一起打包",
      `${junk.length} 个: ${sample}`,
      "files 里写 \"lib\" 会带上整个目录。做法二选一：\n" +
      "  · 删掉这些文件（推荐）\n" +
      "  · 加 .npmignore 排除 *.bak*\n" +
      "不处理会让包体积暴涨，还会把源码备份暴露给别人"));
  } else {
    out.push(r("pass", "L1.5", "pack.junk", "无临时/备份文件", ""));
  }

  // 3. 包体积估算
  const totalBytes = (files || []).reduce((s, f) => s + (f.size || 0), 0);
  if (totalBytes > 300 * 1024) {
    out.push(r("warn", "L1.5", "pack.size",
      "包体积偏大",
      `${(totalBytes / 1024).toFixed(1)} KB`,
      "检查 files 是否把不该打包的东西带上了（node_modules、备份、测试数据）"));
  } else {
    out.push(r("pass", "L1.5", "pack.size", "包体积正常",
      `${(totalBytes / 1024).toFixed(1)} KB`));
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════
//  L2 patch
// ═══════════════════════════════════════════════════════════════

export function checkPatch(text) {
  const out = [];
  if (text == null) {
    out.push(r("fail", "L2", "patch.missing", "patch 文件读不到", "", "确认 dsh.bundle.patch 指向的文件存在"));
    return out;
  }

  const shape = parsePatchShape(text);

  out.push(shape.isArray
    ? r("pass", "L2", "patch.array", "顶层是数组")
    : r("fail", "L2", "patch.array", "顶层不是数组",
      "必须以 - 开头", "改成:\n- insert:\n    - id: my-plugin\n      name: my-plugin"));

  out.push(shape.inserts.length
    ? r("pass", "L2", "patch.insert", "含 insert", `第 ${shape.inserts.join(", ")} 行`)
    : r("fail", "L2", "patch.insert", "没有 insert", "",
      "patch 必须含 insert 列表"));

  if (shape.entries.length) {
    const bad = shape.entries.filter((e) => !e.id || !e.name);
    out.push(bad.length
      ? r("fail", "L2", "patch.entries", "有 entry 缺 id 或 name",
        bad.map((e) => `第 ${e.line} 行`).join(", "), "每个 entry 都要有 id 和 name")
      : r("pass", "L2", "patch.entries", "所有 entry 都有 id + name",
        `${shape.entries.length} 个`));

    // 重复 id 检查（新增）
    const ids = shape.entries.map((e) => e.id).filter(Boolean);
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    if (dup.length) {
      out.push(r("fail", "L2", "patch.dup_id",
        "有重复的 entry id", [...new Set(dup)].join(", "),
        "每个 entry 的 id 必须唯一，否则后一个会覆盖前一个"));
    }
  }

  if (shape.unquotedAt.length) {
    out.push(r("fail", "L2", "patch.at",
      "@ 开头的值没加引号",
      shape.unquotedAt.map((x) => `第 ${x.line} 行: ${x.key}: ${x.value}`).join("; "),
      "YAML 里 @ 是保留指示符，必须写成 name: \"@scope/pkg\""));
  } else {
    out.push(r("pass", "L2", "patch.at", "@ 引号检查", "无问题"));
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════
//  L2.5 output 契约（新增）
// ═══════════════════════════════════════════════════════════════

/**
 * 检查工具 output 的 JSON Schema 形状。
 *
 * 三条硬规则（都是 2026-11-10 实测踩到的）：
 *   1. output 必须含 schema + render
 *   2. schema.properties 里的属性不能带 required: true
 *      required 必须是对象级数组：required: ["text"]
 *   3. render 必须是函数
 */
export function checkOutput(files, pkg) {
  const out = [];
  if (!files || !files.length) return out;

  const entry = pickEntryFiles(files, pkg);
  let merged = "";
  for (const f of entry) merged += "\n" + f.text;

  const A = analyzeCode(merged);
  const decls = A.outputDecls;

  if (!decls.length) {
    // 没有 output 声明 —— 如果也没有 tool 注册，那是纯技能插件，不报
    if (A.toolRegisters.length) {
      out.push(r("fail", "L2.5", "output.missing",
        "有工具注册但完全没有 output 声明",
        `${A.toolRegisters.length} 个工具`,
        "每个 ctx.tools.register 必须有 output: { schema, render }\n" +
        "写 { type: \"text\" } 会报:\n" +
        "  TypeError: tool \"X\" must declare output { schema, render }"));
    }
    return out;
  }

  let badRequired = 0;
  let badTypeText = 0;
  let missingRender = 0;

  for (const d of decls) {
    if (d.badRequired) badRequired++;
    if (d.badTypeText) badTypeText++;
    if (!d.hasRender) missingRender++;
  }

  // 规则 1：output 必须有 render
  out.push(missingRender
    ? r("fail", "L2.5", "output.render",
      "有 output 声明缺 render",
      `${missingRender} 处`,
      "render 必须是函数：\n" +
      "  render: (_args, value) => [{ type: \"text\", text: (value && value.text) || \"\" }]")
    : r("pass", "L2.5", "output.render", "output 含 render", `${decls.length} 处`));

  // 规则 2：不能是 { type: "text" }
  out.push(badTypeText
    ? r("fail", "L2.5", "output.type_text",
      "output 写成了 { type: \"text\" }",
      `${badTypeText} 处`,
      "正确写法（可直接复制）：\n" +
      "const TEXT_OUTPUT = {\n" +
      "  schema: {\n" +
      "    type: \"object\",\n" +
      "    additionalProperties: false,\n" +
      "    properties: { text: { type: \"string\" } },\n" +
      "    required: [\"text\"],\n" +
      "  },\n" +
      "  render: (_args, value) => [{ type: \"text\", text: (value && value.text) || \"\" }],\n" +
      "};")
    : r("pass", "L2.5", "output.type_text", "output 不是裸 type:text"));

  // 规则 3：required 位置
  out.push(badRequired
    ? r("fail", "L2.5", "output.required_position",
      "schema 里 required: true 写在了属性内",
      `${badRequired} 处`,
      "JSON Schema 里 required 是对象级数组，不能写在单个属性里。\n" +
      "  ✗ properties: { text: { type: \"string\", required: true } }\n" +
      "  ✓ properties: { text: { type: \"string\" } },\n" +
      "    required: [\"text\"],\n" +
      "照错写法会在激活阶段报:\n" +
      "  JsonSchemaError: unsupported JSON schema:\n" +
      "  schema.properties.text.required is not supported on type \"string\"")
    : r("pass", "L2.5", "output.required_position",
      "required 位置正确", "对象级数组"));

  // 规则 4：每个工具都有 output
  const noOutput = A.toolRegisters.filter((t) => !t.hasOutput);
  out.push(noOutput.length
    ? r("fail", "L2.5", "output.per_tool",
      "有工具没声明 output",
      noOutput.map((t) => t.name).join(", "),
      "每个 ctx.tools.register 都要写 output: TEXT_OUTPUT")
    : r("pass", "L2.5", "output.per_tool",
      "每个工具都声明了 output", `${A.toolRegisters.length} 个工具`));

  return out;
}

// ═══════════════════════════════════════════════════════════════
//  L3 code
// ═══════════════════════════════════════════════════════════════

export function checkCode(files, pkg) {
  const out = [];
  if (!files || !files.length) {
    out.push(r("fail", "L3", "code.empty", "lib/ 下没有文件", "", "确认 files 与路径"));
    return out;
  }

  // 语义检查只看入口文件（见 pickEntryFiles 的注释）
  const entry = pickEntryFiles(files, pkg);
  let merged = "";
  const perFile = [];
  for (const f of files) {
    const a = analyzeCode(f.text);
    perFile.push({ path: f.path, a });
  }
  for (const f of entry) merged += "\n" + f.text;
  const A = analyzeCode(merged);

  out.push(A.hasApply
    ? r("pass", "L3", "code.apply", "有 export function apply")
    : r("fail", "L3", "code.apply", "缺 export function apply",
      "DSH 靠这个函数加载插件", "export function apply(ctx) { ... }"));

  out.push(A.hasName
    ? r("pass", "L3", "code.name", "有 export const name")
    : r("warn", "L3", "code.name", "缺 export const name", "",
      "export const name = \"my-plugin\""));

  out.push(A.isEsm
    ? r("pass", "L3", "code.esm", "是 ESM 模块")
    : r("warn", "L3", "code.esm", "看起来不是 ESM", "",
      "用 import/export，package.json 加 \"type\": \"module\""));

  // ★ 2026-11-10 实锤：apply(ctx, config) 但函数体读 ctx.config
  if (A.readsCtxConfig) {
    out.push(r("fail", "L3", "code.ctx_config",
      "代码读 ctx.config",
      "Cordis 没有这个属性",
      "插件配置用 apply 的第二参数：\n" +
      "  export function apply(ctx, config) {\n" +
      "    const cfg = (config && typeof config === \"object\") ? config : {};\n" +
      "  }\n" +
      "不要写 ctx.config；也不要把 \"config\" 加进 inject。"));
  }

  // ★ ctx 属性访问 vs inject 声明
  const accessed = [...A.ctxAccess].filter(
    (x) => !BUILTIN_CTX_PROPS.has(x) &&
           (VALID_INJECT_SERVICES.has(x) || true)   // 未知的也算
  );
  const declared = new Set([...A.injectServices, ...BUILTIN_CTX_PROPS]);
  const missing = accessed.filter((x) => !declared.has(x));

  function isProtected(text, prop) {
    const re = /try\s*\{([\s\S]{0,600}?)\}\s*catch/g;
    let mm;
    while ((mm = re.exec(text))) {
      const body = mm[1];
      const access = new RegExp("\\bctx\\s*\\.\\s*" + prop + "\\b");
      if (access.test(body)) return true;
    }
    return false;
  }

  const unprotected = missing.filter((m) => !isProtected(merged, m));
  const protectedOnes = missing.filter((m) => isProtected(merged, m));

  if (unprotected.length) {
    out.push(r("fail", "L3", "code.inject",
      "访问了未在 inject 里声明的 ctx 属性",
      unprotected.join(", "),
      `export const inject = [...现有, ${unprotected.map((m) => `"${m}"`).join(", ")}]\n` +
      `或改用 try/catch 包住访问。\n` +
      `注意：Cordis 会直接抛 "cannot get property \\"X\\" without inject"，\n` +
      `导致 entry 激活失败，沙箱表现为 install_failed。`));
  } else if (protectedOnes.length) {
    out.push(r("warn", "L3", "code.inject",
      "有未声明的 ctx 属性访问，但已被 try/catch 包住",
      protectedOnes.join(", ") + "（不会导致激活失败）",
      `建议仍加进 inject 更规范，或确认 catch 分支有兜底默认值。`));
  } else {
    out.push(r("pass", "L3", "code.inject", "ctx 访问与 inject 一致",
      `访问: ${accessed.join(", ") || "无"}`));
  }

  // 相对 import 指向的文件在不在
  for (const p of perFile) {
    const rel = p.a.imports.filter((i) => i.startsWith("."));
    for (const i of rel) {
      const base = p.path.replace(/\/[^/]+$/, "");
      const target = (base + "/" + i).replace(/\/\.\//g, "/");
      const norm = target.replace(/\.js$/, "");
      const exists = files.some((f) =>
        f.path === target || f.path === norm ||
        f.path === norm + ".js" || f.path === norm + "/index.js");
      if (!exists) {
        out.push(r("fail", "L3", "code.import",
          `import 指向的文件不存在`,
          `${p.path} -> ${i}`,
          "确认 files 里包含该文件，且路径大小写正确"));
      }
    }
  }

  if (A.absolutePaths.length) {
    out.push(r("warn", "L3", "code.abspath",
      "有硬编码绝对路径",
      A.absolutePaths.slice(0, 5).join(", "),
      "改用相对路径或环境变量，否则别人装到不同目录就坏"));
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════
//  L3.5 inject 合法性（新增）
// ═══════════════════════════════════════════════════════════════

/**
 * 检查 inject 里声明的服务名是否合法。
 *
 * 2026-11-10 实测：inject = ["tools","skills","config"]
 *   → pending (waiting for service: config)
 *   → entry 永远不激活
 *
 * 以前的检查器把 config 放进了 known 集合，所以完全没抓到这个错。
 */
export function checkInject(files, pkg) {
  const out = [];
  if (!files || !files.length) return out;

  const entry = pickEntryFiles(files, pkg);
  let merged = "";
  for (const f of entry) merged += "\n" + f.text;
  const A = analyzeCode(merged);

  // 没有 inject 声明：如果访问了 ctx.X 会被 L3 抓到，这里不重复报
  if (!A.injectServices.length) {
    out.push(r("pass", "L3.5", "inject.none",
      "未声明 inject", A.ctxAccess.size ? "但代码访问了 ctx（见 L3）" : ""));
    return out;
  }

  // 1. 检查禁用名单
  const forbidden = A.injectServices.filter((s) => FORBIDDEN_INJECT[s]);
  if (forbidden.length) {
    for (const s of forbidden) {
      const info = FORBIDDEN_INJECT[s];
      out.push(r("fail", "L3.5", "inject.forbidden." + s,
        `inject 里写了 "${s}"，会导致 entry 永远 pending`,
        info.why,
        info.fix));
    }
  }

  // 2. 检查未知服务名
  const unknown = A.injectServices.filter(
    (s) => !VALID_INJECT_SERVICES.has(s) && !FORBIDDEN_INJECT[s] &&
           !BUILTIN_CTX_PROPS.has(s));
  if (unknown.length) {
    out.push(r("fail", "L3.5", "inject.unknown",
      "inject 里有不认识的服务名",
      unknown.join(", "),
      `当前 DSH 支持的服务：${[...VALID_INJECT_SERVICES].join(" / ")}\n` +
      `声明不存在的服务会让 entry 卡在 pending (waiting for service: X)。`));
  }

  // 3. 如果 apply 有 config 参数，给个正面确认
  if (A.hasApplyWithConfig) {
    out.push(r("pass", "L3.5", "inject.apply_config",
      "apply 接受 config 参数", "配置读取方式正确"));
  }

  // 4. 全部合法
  if (!forbidden.length && !unknown.length) {
    out.push(r("pass", "L3.5", "inject.valid",
      "inject 服务名全部合法", A.injectServices.join(", ")));
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════
//  L4 deps
// ═══════════════════════════════════════════════════════════════

export function checkDeps(pkg) {
  const out = [];
  if (!pkg) return out;

  const all = Object.assign({}, pkg.dependencies, pkg.peerDependencies);
  const fileDeps = Object.entries(all).filter(([, v]) => /^file:/.test(String(v)));
  out.push(fileDeps.length
    ? r("fail", "L4", "deps.file", "依赖里有 file: 路径",
      fileDeps.map(([k, v]) => `${k}: ${v}`).join(", "),
      "改成 npm 包名，或移到 devDependencies")
    : r("pass", "L4", "deps.file", "无 file: 依赖"));

  const missingPeer = Object.entries(pkg.peerDependencies || {})
    .filter(([, v]) => !v);
  out.push(missingPeer.length
    ? r("warn", "L4", "deps.peer", "peerDependencies 有未声明版本范围",
      missingPeer.map(([k]) => k).join(", "), "补上版本范围")
    : r("pass", "L4", "deps.peer", "peerDependencies 检查", "无问题"));

  return out;
}

// ═══════════════════════════════════════════════════════════════
//  汇总与渲染
// ═══════════════════════════════════════════════════════════════

const LAYER_ORDER = ["L1", "L1.5", "L2", "L2.5", "L3", "L3.5", "L4"];

const LAYER_NAME = {
  L1: "manifest",
  "L1.5": "打包",
  L2: "patch",
  "L2.5": "output 契约",
  L3: "代码",
  "L3.5": "inject",
  L4: "依赖",
};

export function summarize(results) {
  const fail = results.filter((x) => x.level === "fail").length;
  const warn = results.filter((x) => x.level === "warn").length;
  const pass = results.filter((x) => x.level === "pass").length;
  return {
    fail, warn, pass,
    total: results.length,
    ok: fail === 0,
    ready: fail === 0 && warn <= 1,
  };
}

export function render(results, name) {
  const s = summarize(results);
  const lines = [];
  const icon = { fail: "✗", warn: "⚠", pass: "✓" };

  lines.push(`插件静态检查  ${name || ""}`);
  lines.push("=".repeat(64));
  for (const layer of LAYER_ORDER) {
    const rows = results.filter((x) => x.layer === layer);
    if (!rows.length) continue;
    lines.push("");
    lines.push(`[${layer} ${LAYER_NAME[layer]}]`);
    for (const x of rows) {
      lines.push(`  ${icon[x.level]} ${x.title}${x.detail ? "  —  " + x.detail : ""}`);
      if (x.level === "fail" && x.fix) {
        for (const ln of x.fix.split("\n")) lines.push(`      → ${ln}`);
      }
    }
  }
  lines.push("");
  lines.push("=".repeat(64));
  lines.push(s.ok
    ? `结论: 静态检查通过（${s.pass} 通过 / ${s.warn} 警告 / 0 失败）`
    : `结论: 有 ${s.fail} 项必须先修，否则装不上`);
  if (s.ok && s.warn) lines.push("      警告项不阻塞安装，但建议修");
  return lines.join("\n");
}

// 供外部复用
export { VALID_INJECT_SERVICES, FORBIDDEN_INJECT, analyzeCode, parsePatchShape };
