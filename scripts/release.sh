#!/usr/bin/env bash
# 发布插件（GitHub Actions Trusted Publishing）
# 用法: scripts/release.sh 0.5.7
set -euo pipefail
VER="${1:-}"
[ -n "$VER" ] || { echo "用法: scripts/release.sh <version>"; exit 2; }
cd "$(dirname "$0")/.."
PKG=$(python3 -c "import json;print(json.load(open('package.json'))['name'])")
echo "== 发布 $PKG@$VER =="

echo "-- 检查 1/3: files 完整性"
python3 - <<'PY'
import json, os, sys
d=json.load(open('package.json'))
files=d.get('files') or []
client=(d.get('dsh') or {}).get('client')
bad=[]
for n in ['lib','cordis.patch.yml']:
    if n not in files: bad.append('files 缺 '+n)
for n in ['lib/index.js','cordis.patch.yml']:
    if not os.path.exists(n): bad.append('文件不存在 '+n)
if client:
    if not os.path.exists('lib/client.js'): bad.append('声明了 dsh.client 但缺 lib/client.js')
    if not any(f=='lib' or f.startswith('lib/') for f in files): bad.append('files 未包含 lib')
if bad:
    print('  ✗ ' + '; '.join(bad)); sys.exit(1)
print('  ✓ files/入口完整' + ('（含 client）' if client else ''))
PY

echo "-- 检查 2/3: 语法"
for f in lib/*.js; do node --check "$f" || { echo "  ✗ 语法错误 $f"; exit 1; }; done
echo "  ✓ 全部通过"

echo "-- 检查 3/3: 打包后真装一次"
TMP=$(mktemp -d)
npm pack --pack-destination "$TMP" >/dev/null
TGZ=$(ls "$TMP"/*.tgz | head -1)
tar xzf "$TGZ" -C "$TMP"
node --check "$TMP/package/lib/index.js" || { echo "  ✗ 包内 index 语法错"; exit 1; }
python3 - "$TMP/package/package.json" <<'PY'
import json,sys,os
d=json.load(open(sys.argv[1])); root=os.path.dirname(sys.argv[1])
c=(d.get('dsh') or {}).get('client')
if c and not os.path.exists(os.path.join(root,'lib','client.js')):
    print('  ✗ 包里没有 client.js'); sys.exit(1)
print('  ✓ 包内容校验通过' + ('（含 client）' if c else ''))
PY

echo "-- 写版本号并推送"
python3 - "$VER" <<'PY'
import json,sys
p='package.json'; d=json.load(open(p)); d['version']=sys.argv[1]
open(p,'w').write(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
PY
git add -A
git commit -m "chore(release): v$VER" >/dev/null || true
git tag "v$VER"
git push origin HEAD --tags
echo "-- 已推 tag v$VER，等待 Actions"

GOT=""
for i in $(seq 1 60); do
  sleep 10
  GOT=$(npm view "$PKG" version 2>/dev/null || echo "")
  [ "$GOT" = "$VER" ] && { echo "  ✓ npm latest = $VER"; break; }
  echo "  ... 等待（$i/60，当前 $GOT）"
done
[ "$GOT" = "$VER" ] || { echo "  ✗ 超时未发布"; exit 1; }

echo "-- 校验 tarball"
D=$(mktemp -d); cd "$D"
npm pack "$PKG@$VER" >/dev/null
tar tzf ./*.tgz | grep -q 'package/lib/index.js' && echo "  ✓ 含 index.js"
tar tzf ./*.tgz | grep -q 'package/lib/client.js' && echo "  ✓ 含 client.js" || true
echo "== 完成 $PKG@$VER =="
