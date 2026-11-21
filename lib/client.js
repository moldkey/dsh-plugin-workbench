window.__ModuleLoader__.load({ id: `@liangjiehappy/dsh-plugin-dev-panel`, factory: require => {
  var module = { exports: {} }, exports = module.exports;
  const React = require("react");
  const h = React.createElement;
  const ID = "@liangjiehappy/dsh-plugin-dev-panel/panel";
  const KIND = "plugin-dev-panel";
  const PUB = "https://deepseekbase.com/work/api/public/test-summary";
  const API = "https://deepseekbase.com/work/api";
  const TOKEN_KEY = "dsh_ops_token";
  const S = {
    sec: { marginTop: "14px", paddingTop: "10px", borderTop: "1px solid #eef2f7" },
    h: { fontSize: "12px", letterSpacing: ".04em", color: "#94a3b8", textTransform: "uppercase", margin: "0 0 6px" },
    row: { display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: "13px" },
    btn: { padding: "5px 10px", margin: "4px 6px 0 0", border: "1px solid #dbe2ea", borderRadius: "7px", background: "#f8fafc", color: "#94a3b8", fontSize: "12px", cursor: "not-allowed" },
    btnOn: { padding: "5px 10px", margin: "4px 6px 0 0", border: "1px solid #2563eb", borderRadius: "7px", background: "#2563eb", color: "#fff", fontSize: "12px", cursor: "pointer" },
    tip: { marginTop: "8px", fontSize: "12px", color: "#b45309" },
    code: { fontFamily: "ui-monospace,monospace", fontSize: "18px", letterSpacing: ".18em", fontWeight: 700, color: "#0f172a" },
    inp: { width: "100%", boxSizing: "border-box", padding: "6px 8px", border: "1px solid #dbe2ea", borderRadius: "8px", fontSize: "13px" },
    out: { marginTop: "8px", padding: "8px", background: "#f8fafc", border: "1px solid #eef2f7", borderRadius: "8px", fontSize: "12px", whiteSpace: "pre-wrap", color: "#475569", maxHeight: "120px", overflow: "auto" }
  };
  const row = (k, v, c) => h("div", { key: k, style: S.row }, h("span", { style: { color: "#475569" } }, k), h("span", { style: { fontWeight: 600, color: c || "#0f172a" } }, v));

  function useLogin() {
    const [me, setMe] = React.useState(null);
    const [code, setCode] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [msg, setMsg] = React.useState("");
    const timer = React.useRef(null);
    const fetchMe = React.useCallback(async () => {
      const tk = localStorage.getItem(TOKEN_KEY);
      if (!tk) { setMe(null); return; }
      try {
        const r = await fetch(API + "/me", { headers: { Authorization: "Bearer " + tk } });
        if (r.ok) setMe(await r.json()); else { localStorage.removeItem(TOKEN_KEY); setMe(null); }
      } catch (e) { setMsg("账号接口不可达"); }
    }, []);
    React.useEffect(() => { fetchMe(); return () => clearTimeout(timer.current); }, [fetchMe]);
    const start = async () => {
      setBusy(true); setMsg("");
      try {
        const r = await fetch(API + "/device/code", { method: "POST" });
        const d = await r.json();
        setCode(d);
        const poll = async () => {
          try {
            const tr = await fetch(API + "/device/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_code: d.device_code }) });
            if (tr.ok) { const tk = await tr.json(); if (tk.access_token) { localStorage.setItem(TOKEN_KEY, tk.access_token); setCode(null); setBusy(false); fetchMe(); return; } }
            timer.current = setTimeout(poll, 5000);
          } catch (e) { timer.current = setTimeout(poll, 5000); }
        };
        timer.current = setTimeout(poll, 5000);
      } catch (e) { setBusy(false); setMsg("无法发起登录"); }
    };
    const logout = () => { localStorage.removeItem(TOKEN_KEY); setMe(null); setMsg("已退出"); };
    return { me, code, busy, msg, start, logout };
  }

  function Body() {
    const { me, code, busy, msg, start, logout } = useLogin();
    const [d, setD] = React.useState(null);
    const [err, setErr] = React.useState("");
    const [plugin, setPlugin] = React.useState("");
    const [sub, setSub] = React.useState({ busy: false, msg: "", err: "" });
    const [items, setItems] = React.useState([]);
    const [fb, setFb] = React.useState("");
    const [fbMsg, setFbMsg] = React.useState("");
    const [fbBusy, setFbBusy] = React.useState(false);

    const load = React.useCallback(async () => {
      try {
        const ctl = new AbortController(); const tid = setTimeout(() => ctl.abort(), 20000);
        const r = await fetch(PUB + "?t=" + Date.now(), { cache: "no-store", signal: ctl.signal });
        clearTimeout(tid); setD(await r.json()); setErr("");
      } catch (e) { setErr(e && e.name === "AbortError" ? "网络超时，稍后自动重试（已保留上次数据）" : String((e && e.message) || e)); }
    }, []);
    React.useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

    const loadMine = React.useCallback(async () => {
      const tk = localStorage.getItem(TOKEN_KEY);
      if (!tk) { setItems([]); return; }
      try {
        const r = await fetch(API + "/panel/dev/submissions", { headers: { Authorization: "Bearer " + tk } });
        const j = await r.json();
        if (j && j.items) setItems(j.items);
      } catch (e) {}
    }, []);
    React.useEffect(() => { if (me) loadMine(); }, [me, loadMine]);

    const submitTest = async () => {
      if (plugin.trim().length < 3) return;
      setSub({ busy: true, msg: "", err: "" });
      try {
        const tk = localStorage.getItem(TOKEN_KEY);
        const r = await fetch(API + "/panel/dev/submit", { method: "POST", headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json" }, body: JSON.stringify({ plugin: plugin.trim() }) });
        const j = await r.json();
        if (r.ok) { setSub({ busy: false, msg: "已排队：" + (j.plugin || plugin.trim()), err: "" }); setPlugin(""); loadMine(); }
        else setSub({ busy: false, msg: "", err: j.error || ("HTTP " + r.status) });
      } catch (e) { setSub({ busy: false, msg: "", err: String((e && e.message) || e) }); }
    };

    const submitFb = async () => {
      setFbBusy(true);
      try {
        const r = await fetch("https://deepseekbase.com/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ site: "deepseekbase", type: "问题", page: "dsh-panel:plugin-dev", message: fb.trim(), contact: "" }) });
        const j = await r.json();
        if (j && j.ok) { setFbMsg("已收到，谢谢"); setFb(""); } else setFbMsg("提交失败：" + ((j && (j.error || j.message)) || r.status));
      } catch (e) { setFbMsg("提交失败：" + ((e && e.message) || e)); }
      setFbBusy(false);
    };

    const rate = d && d.total_tested ? Math.round(d.pass * 1000 / d.total_tested) / 10 : null;
    const color = s => s === "pass" ? "#059669" : (s === "pending" || s === "done") ? "#d97706" : "#dc2626";

    return h("div", { style: { padding: "12px 14px", font: "13px/1.6 system-ui,sans-serif", color: "#334155", height: "100%", maxHeight: "calc(100vh - 140px)", boxSizing: "border-box", overflowY: "auto", overflowX: "hidden" } },
      h("div", { style: { fontWeight: 700, fontSize: "14px", color: "#0f172a" } }, "DSH-DEV · 插件开发测试"),

      h("div", { style: S.sec }, h("div", { style: S.h }, "公共信息"),
        !d ? h("div", { style: { color: "#94a3b8" } }, "加载中…") : h("div", null,
          row("已测插件", d.total_tested), row("通过", d.pass, "#059669"), row("失败", d.fail, "#dc2626"),
          row("通过率", rate == null ? "-" : rate + "%"), row("待测队列", d.pending, d.pending ? "#d97706" : "#059669"),
          row("最近测试", d.last_tested_at || "-"))),
      err ? h("div", { style: { color: "#dc2626" } }, "取数失败：" + err) : null,

      h("div", { style: S.sec }, h("div", { style: S.h }, "用户信息"),
        me ? h("div", null, row("账号", me.account), row("角色", me.role, me.role === "owner" ? "#059669" : "#0f172a"),
          h("button", { style: { ...S.btnOn, background: "#fff", color: "#2563eb" }, onClick: logout }, "退出登录"))
          : (code ? h("div", null, h("div", { style: { fontSize: "13px", color: "#475569" } }, "在浏览器里输入这个码授权："),
              h("div", { style: S.code }, code.user_code),
              h("button", { style: S.btnOn, onClick: () => window.open(code.verification_uri_complete, "_blank") }, "打开授权页"),
              h("div", { style: S.tip }, "必须填注册邮箱（否则只能只读）；授权后每 5 秒自动登录"))
            : h("div", null, h("div", { style: S.row }, h("span", null, "登录状态"), h("span", { style: { color: "#b45309", fontWeight: 600 } }, "未登录")),
              h("button", { style: S.btnOn, disabled: busy, onClick: start }, busy ? "获取设备码…" : "登录（设备码）"),
              h("div", { style: S.tip }, "登录后开放你的插件与配额；邮箱必须是注册邮箱，否则只能是只读"))),
        msg ? h("div", { style: { fontSize: "12px", color: "#64748b", marginTop: "4px" } }, msg) : null),

      h("div", { style: S.sec }, h("div", { style: S.h }, "操作" + (me ? "" : "（登录后可用）")),
        h("input", { value: plugin, onChange: e => setPlugin(e.target.value), placeholder: "插件名，如 dsh-ops 或 owner/repo", style: S.inp, disabled: !me }),
        h("div", null, h("button", { disabled: !me || sub.busy || plugin.trim().length < 3, onClick: submitTest, style: me && plugin.trim().length >= 3 ? S.btnOn : S.btn }, sub.busy ? "提交中…" : "提交测试")),
        sub.msg ? h("div", { style: { color: "#059669", fontSize: "12px", marginTop: "6px" } }, sub.msg) : null,
        sub.err ? h("div", { style: { color: "#dc2626", fontSize: "12px", marginTop: "6px" } }, sub.err) : null,
        items.length ? h("div", { style: { marginTop: "8px" } }, h("div", { style: S.h }, "我的提交"),
          items.map(it => h("div", { key: it.id, style: S.row },
            h("a", { href: "https://deepseekbase.com/zh/plugins/" + String(it.plugin || "").toLowerCase().replace(/\//g, "-") + "/", target: "_blank", style: { color: "#2563eb", maxWidth: "62%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, it.plugin),
            h("span", { style: { color: color(it.status), fontWeight: 600 } }, it.status)))) : null,
        h("div", { style: S.tip }, me ? "提交后由 A 机队列执行，结果最多 10 分钟显示" : "登录后可提交测试")),

      h("div", { style: S.sec }, h("div", { style: S.h }, "BAOVOO · 托管"),
        h("div", { style: { fontSize: "12px", color: "#64748b", marginBottom: "6px" } }, "插件托管发布、实例与续费在 BAOVOO 控制台。"),
        h("div", null,
          h("button", { style: S.btnOn, onClick: () => window.open("https://baovoo.com/", "_blank") }, "打开托管控制台"),
          h("button", { style: S.btnOn, onClick: () => window.open("https://baovoo.com/dsh-plugin-hosting/", "_blank") }, "建站 / 选套餐"),
          h("button", { style: S.btnOn, onClick: () => window.open("https://baovoo.com/trial/", "_blank") }, "申请试用"))),

      h("div", { style: S.sec }, h("div", { style: S.h }, "问题反馈"),
        h("textarea", { value: fb, onChange: e => setFb(e.target.value), rows: 3, placeholder: "遇到问题、或希望加什么功能（至少 10 个字）", style: { width: "100%", boxSizing: "border-box", padding: "8px", border: "1px solid #dbe2ea", borderRadius: "8px", font: "13px/1.5 system-ui,sans-serif", resize: "vertical" } }),
        h("div", null, h("button", { disabled: fb.trim().length < 10 || fbBusy, onClick: submitFb, style: fb.trim().length < 10 || fbBusy ? S.btn : S.btnOn }, fbBusy ? "提交中…" : "提交")),
        h("div", { style: { marginTop: "4px", fontSize: "11.5px", color: "#94a3b8", textAlign: "right" } }, fb.trim().length + " 字" + (fb.trim().length < 10 ? "（至少 10 字）" : "")),
        fbMsg ? h("div", { style: { marginTop: "6px", fontSize: "12px", color: fbMsg.indexOf("已收到") === 0 ? "#059669" : "#dc2626" } }, fbMsg) : null),

      h("div", { style: { marginTop: "10px", fontSize: "12px", color: "#94a3b8" } }, d ? "更新于 " + d.updated_at + "（每 60 秒刷新）" : "每 60 秒刷新"),
      d && d.updated_at && (Date.now() - new Date(String(d.updated_at).replace(" ", "T")).getTime() > 30 * 60 * 1000)
        ? h("div", { style: { marginTop: "4px", fontSize: "12px", color: "#b45309" } }, "⚠ 数据可能过期（超过 30 分钟未更新）") : null);
  }

  function apply(ctx) {
    try { const t = setTimeout(() => { try { ctx.sidebarRight.openTab(KIND) } catch (e) {} }, 1500); if (ctx.effect) ctx.effect(() => () => clearTimeout(t), "panel: auto open"); } catch (e) {}
    ctx.effect(() => ctx.sidebarRightTabs.register({ id: ID, kind: KIND, title: () => "DSH-DEV" }), "panel: tab type");
    ctx.effect(() => ctx.slots.register({ name: "sidebar.right.pane.tab", key: ID }, Body), "panel: body");
  }
  exports.apply = apply;
  exports.inject = ["slots", "sidebarRight", "sidebarRightTabs"];
  return module.exports;
}});
