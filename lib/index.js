/**
 * DSH 插件开发测试工作台 —— 主入口
 *
 * 一个插件从零到通过沙箱的完整闭环：
 *
 *   plugin_new      生成脚手架（manifest + patch + 入口 + 技能）
 *   plugin_check    静态检查四层（manifest/patch/代码/依赖）
 *   plugin_test     提交沙箱四阶段测试（安装/列装/挂载/启动）
 *   plugin_result   查测试结果
 *   plugin_explain  解释失败原因与修法
 *
 * 设计原则：
 *   · 不写本地文件？—— plugin_new 要写，这是它存在的意义
 *   · 所有工具必须声明正确的 output: { schema, render }
 *   · inject 只声明真正访问的服务
 */

import {
  checkManifest, checkPatch, checkCode, checkDeps,
  checkPackaging, checkOutput, checkInject,
  summarize, render,
} from "./checks.js";
import { ALL_SKILLS } from "./skills.js";

export const name = "dsh-plugin-workbench";

// 只用 tools 和 skills。不碰 ctx.config（2026-11-10 的教训）。
export const inject = ["tools", "skills"];

// ⚠️ 正确的 output 声明：必须含 schema + render
// 2026-11-10 教训（两次）：
//   写成 { type: "text" } → TypeError: must declare output { schema, render }
//   写成 properties: { text: { type: "string", required: true } }
//     → JsonSchemaError: required is not supported on type "string"
// 所以 required 必须是对象级数组。
const TEXT_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string" },
    },
    required: ["text"],
  },
  render: (_args, value) => [
    { type: "text", text: (value && value.text) || "" },
  ],
};

// ── 文件操作 ──
async function fsModule() {
  return await import("node:fs/promises");
}

async function readText(p) {
  try {
    const fs = await fsModule();
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function exists(p) {
  try {
    const fs = await fsModule();
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function norm(p) {
  return String(p || "").replace(/[\\]+/g, "/").replace(/\/+$/, "");
}

async function listCodeFiles(dir, base = dir, acc = [], depth = 0, includeAll = false) {
  if (depth > 4 || acc.length > 200) return acc;
  let entries;
  try {
    const fs = await fsModule();
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === "node_modules") continue;
    // includeAll 模式下连 .bak / .log 都要看，否则发现不了误打包
    if (!includeAll && e.name.startsWith(".")) continue;
    const full = norm(dir) + "/" + e.name;
    if (e.isDirectory()) {
      await listCodeFiles(full, base, acc, depth + 1, includeAll);
    } else if (includeAll || /\.(js|mjs|cjs|ts)$/.test(e.name)) {
      acc.push(full);
    }
  }
  return acc;
}

// ═══════════════════════════════════════════════════════════════
//  脚手架模板
// ═══════════════════════════════════════════════════════════════

function scaffold(name, withSkill) {
  const pkg = {
    name,
    version: "0.1.0",
    description: "一句话说清这个插件做什么",
    type: "module",
    main: "lib/index.js",
    files: withSkill
      ? ["lib", "cordis.patch.yml", "README.md"]
      : ["lib", "cordis.patch.yml"],
    keywords: ["dsh", "dsh-plugin"],
    license: "MIT",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
    engines: { dsh: ">=0.2.0-rc.2" },
  };

  const patch = `# ${name}
- insert:
    - id: ${name.replace(/^@[^/]+\//, "")}
      name: "${name}"
`;

  const indexJs = `/**
 * ${name}
 */

export const name = "${name.replace(/^@[^/]+\//, "")}";

// 只声明真正访问的 ctx 服务。
// 访问未声明的服务会抛 "cannot get property X without inject"，
// 导致 entry 不激活（沙箱表现为 install_failed）。
export const inject = ["tools"];
${withSkill ? '// 如需注册技能，改成 ["tools", "skills"]\n' : ""}
// 正确的 output 声明。
//
//   ✗ { type: "text" }
//     → TypeError: tool "X" must declare output { schema, render }
//   ✗ properties: { text: { type: "string", required: true } }
//     → JsonSchemaError: required is not supported on type "string"
//   ✓ 下面这个：required 是对象级数组，不在属性里
const TEXT_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string" },
    },
    required: ["text"],
  },
  render: (_args, value) => [
    { type: "text", text: (value && value.text) || "" },
  ],
};

// 插件配置：用 apply 的第二个参数，不要读 ctx.config
// （也不要把 "config" 写进 inject，那会永远 pending）
export function apply(ctx, config) {
  const cfg = (config && typeof config === "object") ? config : {};
  void cfg;   // 现在没用到配置，留着占位

  ctx.tools.register({
    name: "my_tool",
    description:
      "一句话说清这个工具做什么。必须让人判断出什么情况下该调用它。" +
      "当用户说「XX」时使用。",
    parameters: {
      q: { type: "string", required: true, description: "查询词" },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      return { text: "结果: " + (args?.q || "") };
    },
  });
}
`;

  const readme = `# ${name}

一句话说清这个插件做什么。

## 安装

\`\`\`bash
dsh plugin --profile web add ${name}
\`\`\`

## 工具

| 工具 | 什么时候用 |
|---|---|
| \`my_tool\` | 说清场景 |

## 许可

MIT
`;

  return { pkg, patch, indexJs, readme };
}

// ═══════════════════════════════════════════════════════════════
//  检查
// ═══════════════════════════════════════════════════════════════

async function doCheck(dir) {
  const root = norm(dir || ".");
  const results = [];

  const pkgText = await readText(root + "/package.json");
  let pkg = null;
  if (pkgText) {
    try {
      pkg = JSON.parse(pkgText);
    } catch (e) {
      results.push({
        level: "fail", layer: "L1", id: "manifest.json",
        title: "package.json 不是合法 JSON",
        detail: String(e.message).slice(0, 100),
        fix: "修掉语法错误",
      });
    }
  }
  results.push(...checkManifest(pkg));

  let patchText = null;
  const patchRel = pkg?.dsh?.bundle?.patch;
  if (patchRel) {
    patchText = await readText(root + "/" + String(patchRel).replace(/^\.\//, ""));
  }
  results.push(...checkPatch(patchText));

  const libDir = root + "/lib";
  let codeFiles = [];
  if (await exists(libDir)) {
    for (const p of (await listCodeFiles(libDir)).slice(0, 20)) {
      const t = await readText(p);
      if (t != null) {
        codeFiles.push({
          path: norm(p).replace(norm(root) + "/", ""),
          text: t,
          size: Buffer.byteLength(t, "utf8"),
        });
      }
    }
  }
  if (!codeFiles.length && pkg?.main) {
    const t = await readText(root + "/" + String(pkg.main).replace(/^\.\//, ""));
    if (t != null) {
      codeFiles.push({
        path: String(pkg.main),
        text: t,
        size: Buffer.byteLength(t, "utf8"),
      });
    }
  }

  // 打包内容检查（新增 2026-11-10）
  // 需要把 lib 目录下所有文件（含 .bak）列出来，才能发现误打包
  let allFiles = [];
  if (await exists(libDir)) {
    const all = await listCodeFiles(libDir, libDir, [], 0, true);   // includeAll=true
    for (const p of all.slice(0, 200)) {
      const rel = norm(p).replace(norm(root) + "/", "");
      let sz = 0;
      try {
        const t = await readText(p);
        sz = t != null ? Buffer.byteLength(t, "utf8") : 0;
      } catch { sz = 0; }
      allFiles.push({ path: rel, size: sz });
    }
  }
  results.push(...checkPackaging(pkg, allFiles));

  results.push(...checkOutput(codeFiles, pkg));   // 新增：L2.5
  results.push(...checkCode(codeFiles, pkg));
  results.push(...checkInject(codeFiles, pkg));   // 新增：L3.5
  results.push(...checkDeps(pkg));

  return results;
}

// ═══════════════════════════════════════════════════════════════
//  沙箱 API
// ═══════════════════════════════════════════════════════════════

const DSB = "https://deepseekbase.com";

// ═══════════════════════════════════════════════════════════════
//  网络 / IP 健康诊断
//
//  2026-11-11 实测：插件连续 429 后，服务器 fail2ban 把本机 IP 封了。
//  之后所有请求都只报 "fetch failed"，用户完全不知道是被封了、网断了、
//  还是服务挂了。这一层就是把这个说不清的错误变成能操作的结论。
// ═══════════════════════════════════════════════════════════════

/** 用一个「对照组」主机判断本机网络是否正常 */
const CONTROL_HOSTS = [
  "https://api.deepseek.com",
  "https://registry.npmjs.org",
];

async function probe(url, timeoutMs = 8000) {
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  const started = Date.now();
  try {
    const r = await fetch(url, {
      method: "HEAD",
      signal: ac ? ac.signal : undefined,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; dsh-netcheck/1.0)" },
    });
    return { ok: true, status: r.status, ms: Date.now() - started };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      code: (e && e.cause && (e.cause.code || e.cause.message)) ||
            (e && e.name) || "UNKNOWN",
    };
  } finally {
    if (t) clearTimeout(t);
  }
}

/** 把 fetch 的错误对象翻译成人话 */
function errorCode(e) {
  if (!e) return "UNKNOWN";
  const c = e.cause;
  if (c) {
    if (c.code) return c.code;
    if (c.message) return c.message;
  }
  return e.name || e.message || "UNKNOWN";
}

/**
 * 诊断网络状况。
 * 返回 { kind, title, detail[], actions[] }
 *
 * kind 取值：
 *   network_down   本机完全没网
 *   ip_blocked     本机能上网，但连不上我们的站（很可能 IP 被封）
 *   service_down   我们的站挂了（对照组正常、我们 5xx）
 *   slow           能连但很慢
 *   ok             正常
 */
async function diagnoseNetwork(failedCode) {
  // 1. 对照组：本机能不能上网
  const probes = [];
  for (const h of CONTROL_HOSTS) {
    probes.push({ host: h, ...(await probe(h)) });
    if (probes[probes.length - 1].ok) break;   // 一个通就够了
  }
  const controlOk = probes.some((p) => p.ok);

  // 2. 能不能连我们的站
  const dsb = await probe(DSB + "/test/health", 8000);

  const detail = [];
  detail.push("  本机网络:  " +
    (controlOk ? "正常（" + probes.find((p) => p.ok).host + " 可达）"
               : "不通（对照组全部失败）"));
  detail.push("  目标站点:  " +
    (dsb.ok ? "可达（HTTP " + dsb.status + "）"
            : "连不上（" + (dsb.code || "超时") + "）"));
  detail.push("  失败代码:  " + (failedCode || "UNKNOWN"));

  if (!controlOk) {
    return {
      kind: "network_down",
      title: "本机网络不通",
      detail,
      actions: [
        "检查这台机器能不能上网（浏览器打开任意网站试试）",
        "检查代理 / VPN / 防火墙设置",
        "如果在公司或校园网，可能需要配 HTTP 代理",
      ],
    };
  }

  if (dsb.ok) {
    return {
      kind: "ok",
      title: "现在网络已恢复",
      detail,
      actions: ["刚才的失败可能是瞬时抖动，重试一次"],
    };
  }

  // 对照通、目标不通 —— 最可能是 IP 被封
  return {
    kind: "ip_blocked",
    title: "本机 IP 很可能被服务器防火墙封了",
    detail,
    actions: [
      "这不是插件的问题，也不是你操作错了。",
      "常见原因：短时间内重复请求（例如额度用完后反复点测试），",
      "          触发了服务器的 fail2ban 或限流规则。",
      "解决办法：",
      "  1. 等 10–60 分钟，多数 fail2ban 规则会自动过期",
      "  2. 或换一个网络（手机热点 / 其它 WiFi）立即恢复",
      "  3. 或联系站点管理员把你的出口 IP 加白名单",
      "查自己的出口 IP：在浏览器打开 https://myip.ipip.net",
    ],
  };
}

/** 把诊断结果渲染成给人看的文本 */
function renderDiagnosis(d) {
  const out = [];
  out.push(d.title);
  out.push("=".repeat(52));
  for (const line of d.detail) out.push(line);
  out.push("");
  for (const a of d.actions) out.push(a);
  return out.join("\n");
}

async function api(path, body, timeoutMs = 90000) {
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetch(DSB + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; dsh-plugin-workbench/0.1)",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac ? ac.signal : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
    return { status: res.status, data };
  } catch (e) {
    // 不再只报 "请求失败" —— 跑一次诊断，告诉用户到底是什么问题
    const code = errorCode(e);
    let diag;
    try {
      diag = await diagnoseNetwork(code);
    } catch {
      diag = null;
    }
    return {
      error: diag
        ? renderDiagnosis(diag)
        : `请求失败: ${String(e.message).slice(0, 120)}`,
      netError: code,
      diagnosis: diag,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════
//  失败解释
// ═══════════════════════════════════════════════════════════════

const EXPLAIN = {
  "output.schema": {
    why: "DSH 要求每个工具声明 output 的形状，含 schema 与 render 两个字段。\n" +
         "schema 描述返回值结构，render 把返回值渲染成给模型看的文本块。",
    symptom: "TypeError: tool \"X\" must declare output { schema, render, presentationMeta? }\n" +
             "整个 entry 激活失败，插件列表里能看到但功能全不生效。",
    fix: "const TEXT_OUTPUT = {\n" +
         "  schema: {\n" +
         "    type: \"object\",\n" +
         "    additionalProperties: false,\n" +
         "    properties: { text: { type: \"string\" } },\n" +
         "    required: [\"text\"],          ← 对象级数组\n" +
         "  },\n" +
         "  render: (_args, value) => [{ type: \"text\", text: (value && value.text) || \"\" }],\n" +
         "};\n" +
         "然后在每个 ctx.tools.register 里写 output: TEXT_OUTPUT",
  },
  "output.required": {
    why: "output.schema 走严格 JSON Schema，required 必须是对象级数组，\n" +
         "不能写在单个属性里。注意 parameters 的 required: true 是 DSH 自己的格式，\n" +
         "两者规则不同，很容易混。",
    symptom: "JsonSchemaError: unsupported JSON schema:\n" +
             "  schema.properties.text.required is not supported on type \"string\"\n" +
             "整个 entry 激活失败。",
    fix: "✗ properties: { text: { type: \"string\", required: true } }\n" +
         "✓ properties: { text: { type: \"string\" } },\n" +
         "  required: [\"text\"],",
  },
  "code.inject": {
    why: "Cordis 在 inject 未声明某个服务时禁止访问 ctx.<该服务>，直接抛错。",
    symptom: "沙箱 verdict=install_failed，first_error 只有一行无关日志。",
    fix: "把真正用到的服务名加进 inject：\n" +
         "  export const inject = [\"tools\"];\n" +
         "可注入服务：tools / systemPrompt / skills / fs / llm / web / session / shell\n" +
         "\n" +
         "⚠ 不要把 \"config\" 写进 inject —— 它不是服务。\n" +
         "  写进去会让 entry 永远卡在 pending (waiting for service: config)。\n" +
         "  插件配置要用 apply 的第二个参数取：\n" +
         "    export function apply(ctx, config) {\n" +
         "      const cfg = config || {};\n" +
         "    }",
  },
  "inject.forbidden": {
    why: "inject 里的每一项都会被 Cordis 当成「要等别的插件提供的服务」。\n" +
         "声明一个不存在的服务，entry 就永远等不到它。",
    symptom: "warning: 1 entry did not activate\n" +
             "  pending (waiting for service: config)",
    fix: "从 inject 里删掉 \"config\"。配置用 apply 第二参数：\n" +
         "  export function apply(ctx, config) {\n" +
         "    const cfg = (config && typeof config === \"object\") ? config : {};\n" +
         "  }",
  },
  "code.ctx_config": {
    why: "Cordis 的 ctx 上没有 config 属性。插件配置是作为 apply 的第二个\n" +
         "参数传进来的（来自 cordis.patch.yml 里 entry 的 config）。",
    symptom: "entry 能激活，但所有工具都报「API key 无效或缺失」之类，\n" +
             "因为 cfg 永远是空对象。",
    fix: "✗ export function apply(ctx) {\n" +
         "    if (ctx.config) cfg = ctx.config;\n" +
         "  }\n" +
         "✓ export function apply(ctx, config) {\n" +
         "    const cfg = (config && typeof config === \"object\") ? config : {};\n" +
         "  }",
  },
  "pack.junk": {
    why: "files 里写 \"lib\" 会把 lib 目录下所有文件都打包，\n" +
         "包括 .bak / .log / .tmp。",
    symptom: "npm 包体积暴涨（14.6 KB → 108 KB），源码备份被公开。",
    fix: "发布前删掉这些文件，或加 .npmignore：\n" +
         "  *.bak\n" +
         "  *.bak.*\n" +
         "  *.log",
  },
  "patch.at": {
    why: "YAML 里 @ 是保留指示符，出现在值开头必须加引号。",
    symptom: "YAMLException: failed to parse overlay",
    fix: "name: \"@scope/pkg\"",
  },
  "manifest.engines.upper": {
    why: "写了上界后，DSH 出新版本时插件立刻被判不兼容。",
    symptom: "incompatible with dsh x.y.z",
    fix: "\"engines\": { \"dsh\": \">=0.2.0-rc.2\" }",
  },
  "manifest.files.patch": {
    why: "npm publish 只打包 files 里列的文件。",
    symptom: "本地能装，从 npm 装失败",
    fix: "\"files\": [\"lib\", \"cordis.patch.yml\"]",
  },
  "deps.file": {
    why: "file: 依赖指向本机路径，别人装不到。",
    symptom: "别人 npm install 失败",
    fix: "改成 npm 包名，或移到 devDependencies",
  },
  "code.apply": {
    why: "DSH 靠 apply(ctx) 加载插件。",
    symptom: "装上了但什么都没发生",
    fix: "export function apply(ctx) { ... }",
  },
};

// ═══════════════════════════════════════════════════════════════
//  注册
// ═══════════════════════════════════════════════════════════════

export function apply(ctx) {
  // ── 1. plugin_new ──
  ctx.tools.register({
    name: "plugin_new",
    description:
      "在指定目录生成一个可安装的 DSH 插件脚手架：package.json、cordis.patch.yml、" +
      "lib/index.js、README.md。生成的代码已按标准写好 output schema 与 inject 声明，" +
      "避免最常见的两个激活失败原因。" +
      "当用户说「新建一个 DSH 插件」「帮我搭个插件架子」时使用。",
    parameters: {
      name: {
        type: "string",
        required: true,
        description: "npm 包名，如 @scope/my-plugin 或 my-plugin",
      },
      dir: {
        type: "string",
        required: true,
        description: "生成到哪个目录",
      },
      with_skill: {
        type: "boolean",
        required: false,
        description: "是否同时生成技能注册的示例代码，默认 false",
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const name = String(args?.name || "").trim();
      const dir = norm(args?.dir || "");
      if (!name || !dir) return { text: "缺少参数：name 和 dir 都必填" };
      if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) {
        return { text: `包名不合法：${name}\n应该是 my-plugin 或 @scope/my-plugin（小写字母、数字、- . _）` };
      }
      if (await exists(dir + "/package.json")) {
        return { text: `目录里已经有 package.json：${dir}\n换一个目录，或先清空。` };
      }

      const sc = scaffold(name, !!args?.with_skill);
      const fs = await fsModule();
      try {
        await fs.mkdir(dir + "/lib", { recursive: true });
        await fs.writeFile(dir + "/package.json", JSON.stringify(sc.pkg, null, 2) + "\n");
        await fs.writeFile(dir + "/cordis.patch.yml", sc.patch);
        await fs.writeFile(dir + "/lib/index.js", sc.indexJs);
        await fs.writeFile(dir + "/README.md", sc.readme);
      } catch (e) {
        return { text: `写文件失败：${String(e.message).slice(0, 150)}` };
      }

      // ── 自检：生成的代码必须能通过自己的检查 ──
      // 2026-11-10 教训：scaffold 模板里 required 位置写错，
      // 导致 plugin_new 生成的插件全部装不上，而当时的检查器又查不出来。
      let selfCheck = "";
      try {
        const rc = await doCheck(dir);
        const bad = rc.filter((x) => x.level === "fail");
        if (bad.length) {
          selfCheck =
            "\n\n⚠ 自检未通过（这是插件的 bug，不是你的问题）：\n" +
            bad.map((x) => `  ✗ [${x.layer}] ${x.title} — ${x.detail}`)
               .join("\n") +
            "\n请把这段反馈给插件作者。";
        } else {
          selfCheck = "\n\n✓ 自检通过：生成的代码能过静态检查。";
        }
      } catch (e) {
        selfCheck = "\n\n（自检执行失败：" + String(e.message).slice(0, 80) + "）";
      }

      return {
        text: "已生成插件脚手架\n" +
          "=".repeat(52) + "\n" +
          `  ${dir}/package.json\n` +
          `  ${dir}/cordis.patch.yml\n` +
          `  ${dir}/lib/index.js\n` +
          `  ${dir}/README.md\n` +
          selfCheck + "\n\n" +
          "下一步：\n" +
          "  1. 改 lib/index.js 里的工具名、描述、参数\n" +
          "  2. plugin_check(dir=\"" + dir + "\") 静态检查\n" +
          "  3. npm publish 发布\n" +
          "  4. plugin_test(plugin=\"" + name + "\") 提交沙箱\n" +
          "  5. plugin_result(plugin=\"" + name + "\") 查结果",
      };
    },
  });

  // ── 2. plugin_check ──
  ctx.tools.register({
    name: "plugin_check",
    description:
      "对本地插件目录做四层静态检查：manifest 必填字段、patch 语法与结构、" +
      "代码里的 ctx 访问与 inject 声明是否一致、依赖里有没有 file: 路径。" +
      "不联网、只读目录。当用户说「我的插件装不上」「帮我检查插件」时使用。",
    parameters: {
      dir: { type: "string", required: true, description: "插件根目录（含 package.json）" },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const dir = args?.dir;
      if (!dir) return { text: "缺少 dir 参数" };
      const results = await doCheck(dir);
      const s = summarize(results);
      return {
        text: render(results, dir) + (s.ok
          ? "\n\n下一步：npm publish 后，用 plugin_test 提交沙箱。"
          : "\n\n先修 ✗ 项，再提交沙箱。"),
      };
    },
  });

  // ── 3. plugin_test ──
  ctx.tools.register({
    name: "plugin_test",
    description:
      "把已发布到 npm 的插件提交到 deepseekbase 沙箱做四阶段测试" +
      "（安装/列装/挂载/启动）。返回队列 id。" +
      "当用户说「帮我测一下这个插件」「提交沙箱测」时使用。",
    parameters: {
      plugin: {
        type: "string",
        required: true,
        description: "npm 包名，如 @scope/name（不带 @版本后缀）",
      },
      dsh_version: {
        type: "string",
        required: false,
        description: "要测的 DSH 版本，默认 0.2.2-rc.1",
      },
      note: {
        type: "string",
        required: false,
        description: "备注，写清这次改了什么",
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const plugin = String(args?.plugin || "").trim();
      if (!plugin) return { text: "缺少 plugin 参数" };
      if (plugin.includes("@", 1)) {
        return { text: "不要把 @版本 写在包名里。用 plugin=\"@scope/name\"，版本由 npm latest 决定。" };
      }
      const body = { plugin };
      if (args?.dsh_version) body.dsh_version = args.dsh_version;
      if (args?.note) body.note = String(args.note).slice(0, 300);

      const r = await api("/test/submit", body);
      if (r.error) return { text: r.error };

      const d = r.data || {};

      // api() 在 HTTP 非 2xx 时也返回 { status, data }，不会设 error。
      // 必须自己判断，否则 429 会被当成提交成功。
      if (r.status >= 400 || d.error) {
        const isQuota = r.status === 429;
        const mins = d.resets_in_seconds != null
          ? Math.ceil(d.resets_in_seconds / 60) : null;
        const lines = [];
        lines.push(isQuota ? "沙箱测试额度已用完" : "提交失败");
        lines.push("=".repeat(52));

        if (isQuota) {
          if (d.used_today != null) {
            lines.push("  今日已用:    " + d.used_today + " 次");
          }
          lines.push("  免费额度:    " +
                     (d.free_tier_per_day != null ? d.free_tier_per_day : 3) +
                     " 次/天");
          if (mins != null) lines.push("  重置倒计时:  " + mins + " 分钟");
        } else {
          if (d.error) lines.push("  原因:        " + String(d.error));
          if (d.hint) lines.push("  说明:        " + String(d.hint));
          if (d.allowed) {
            lines.push("  允许的版本:  " + JSON.stringify(d.allowed));
          }
        }

        lines.push("");
        lines.push("这次测试没有提交，不要用 plugin_result 去查。");
        lines.push("");
        lines.push("你可以：");
        if (isQuota && mins != null) {
          lines.push("  · 等 " + mins + " 分钟，额度自动重置（免费）");
        }
        lines.push("  · 开通更高额度：" +
                   (d.upgrade || "https://deepseekbase.com/zh/plugin-pricing/"));
        lines.push("");
        lines.push("如果你只是想确认「这个包现在能不能装」，");
        lines.push("先用 plugin_result(plugin=\"" + plugin + "\") 查历史结果，不消耗额度。");
        return { text: lines.join("\n") };
      }

      const out = ["已提交沙箱测试", "=".repeat(52)];
      if (d.id) out.push("  队列 id:     " + d.id);
      if (d.message) out.push("  说明:        " + d.message);
      if (d.used_today != null) out.push("  今日已用:    " + d.used_today + " 次");
      if (d.left_today != null) out.push("  今日剩余:    " + d.left_today + " 次");
      out.push("");
      out.push("几分钟后用 plugin_result(plugin=\"" + plugin + "\") 查结果。");
      return { text: out.join("\n") };
    },
  });

  // ── 4. plugin_result ──
  ctx.tools.register({
    name: "plugin_result",
    description:
      "查某个插件在 deepseekbase 沙箱的最新测试结果：四阶段（安装/列装/挂载/启动）" +
      "判定、node_modules 大小、首次错误。" +
      "当用户问「我那个插件测过了吗」「测试结果怎么样」时使用。",
    parameters: {
      plugin: { type: "string", required: true, description: "npm 包名或 github:owner/repo" },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const plugin = String(args?.plugin || "").trim();
      if (!plugin) return { text: "缺少 plugin 参数" };
      const r = await api("/test/result?plugin=" + encodeURIComponent(plugin));
      if (r.error) return { text: r.error };
      if (r.status === 404) {
        return {
          text: "还没有这个插件的测试结果：" + plugin + "\n" +
            "用 plugin_test(plugin=\"" + plugin + "\") 提交一次。",
        };
      }
      const d = r.data || {};

      const lines = [];
      lines.push("沙箱测试结果  " + (d.plugin || plugin));
      lines.push("=".repeat(52));
      lines.push("  verdict:     " + (d.verdict || "?"));
      lines.push("  dsh_version: " + (d.dsh_version || "?"));
      lines.push("  tested_at:   " + (d.tested_at || "?"));
      lines.push("  install_ok:  " + (d.install_ok));
      if (d.node_modules_mb != null) lines.push("  node_modules: " + d.node_modules_mb + " MB");
      if (d.error) lines.push("  error:       " + String(d.error).slice(0, 300));
      if (d.note) lines.push("  note:        " + String(d.note).slice(0, 300));

      if (d.verdict && d.verdict !== "pass") {
        lines.push("");
        lines.push("失败的话，用 plugin_explain 看修法。可用 key：");
        lines.push("  " + Object.keys(EXPLAIN).join(", "));
      } else if (d.verdict === "pass") {
        lines.push("");
        lines.push("通过。可以发布了。");
      }
      return { text: lines.join("\n") };
    },
  });

  // ── 5. plugin_explain ──
  ctx.tools.register({
    name: "plugin_explain",
    description:
      "解释某一类 DSH 插件失败的原因、症状和修法。可用 key：" +
      "output.schema（工具缺 output 声明）、code.inject（ctx 属性未声明 inject）、" +
      "patch.at（YAML 里 @ 没引号）、manifest.engines.upper（版本写了上界）、" +
      "manifest.files.patch（files 漏 patch）、deps.file（file: 依赖）、" +
      "code.apply（缺 apply 函数）。当用户问「这个错误是什么意思」时使用。",
    parameters: {
      key: { type: "string", required: false, description: "失败类型 key；留空列出全部" },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const key = String(args?.key || "").trim();
      if (!key) {
        return {
          text: "可解释的类型：\n" +
            Object.keys(EXPLAIN).map((k) => "  · " + k).join("\n") +
            "\n\n用法：plugin_explain(key=\"output.schema\")",
        };
      }
      const e = EXPLAIN[key];
      if (!e) {
        const near = Object.keys(EXPLAIN).filter((k) => k.includes(key) || key.includes(k));
        return {
          text: `没有这个 key：${key}\n` +
            (near.length ? "相近的: " + near.join(", ") + "\n" : "") +
            "全部可用: " + Object.keys(EXPLAIN).join(", "),
        };
      }
      return { text: `${key}\n${"=".repeat(52)}\n\n原因\n${e.why}\n\n症状\n${e.symptom}\n\n修法\n${e.fix}` };
    },
  });

  // ── 技能 ──
  try {
    if (ctx.skills && typeof ctx.skills.register === "function") {
      for (const s of ALL_SKILLS) ctx.skills.register(s);
    }
  } catch {
    // 技能注册失败不影响工具
  }
}
