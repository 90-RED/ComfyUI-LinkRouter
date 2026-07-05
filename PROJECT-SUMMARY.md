# ComfyUI-LinkRouter — 完整專案總結文件

> 本文件是整個插件的完整知識庫。給任何 AI 模型或開發者閱讀後,
> 應能完全理解專案背景、架構、每個設計決定的原因、已知陷阱,
> 並能安全地繼續開發或修 bug。
> 最後更新:2026-07-05(所有功能完成,發佈前狀態)

---

## 1. 專案是什麼

**ComfyUI 前端插件:workflow 連線自動避開 node(orthogonal edge routing)。**

- 線變成直角折線(smooth-step 風格),自動繞開所有 node,不再穿過 node 亂成一團
- 附帶:hover/選中高亮 + 流動動畫、浮動快捷按鈕列、完整設定面板
- 純前端 JavaScript,零 Python 邏輯、零依賴、**完全不影響生成效能和 VRAM**
  (只是瀏覽器 canvas 畫線,與後端 GPU/推理完全隔離)

### 檔案位置(開發中)
```
C:\Users\so\Documents\hermes\CEI_v3.9.0_code\ComfyUI-Easy-Install\ComfyUI\custom_nodes\ComfyUI-LinkRouter\
├── __init__.py               # 空 mappings + WEB_DIRECTORY = "./web"
├── web/
│   ├── router.js             # 核心演算法(純幾何,零依賴,可獨立測試)
│   ├── state.js              # 共享狀態 (S, router, pathCache 等)
│   ├── settings.js           # 設定表 + ComfyUI 註冊邏輯
│   ├── routing.js            # 路由核心 (routeAll, stretchPath 等)
│   ├── draw.js               # 繪圖 + 動畫 + hover 偵測
│   ├── ui.js                 # 浮動按鈕列 + 設定面板
│   └── smart-edge.js         # 主入口 (~45行, registerExtension)
└── test/
    └── router.test.mjs       # 單元測試(node test/router.test.mjs)
```

### 測試環境
- ComfyUI-Easy-Install v3.9.0,**comfyui_frontend_package 1.45.20**
- 前端套件位置:`python_embeded/Lib/site-packages/comfyui_frontend_package/static/assets/`
  (要查前端內部實作時 grep 這裡的 `api-*.js`,minified 但可搜 class 名)

---

## 2. 核心演算法(router.js)

### 依據論文
**Wybrow, Marriott, Stuckey — "Orthogonal Connector Routing" (Graph Drawing 2009)**
- PDF: https://users.monash.edu/~mwybrow/papers/wybrow-gd-2009.pdf
- 這是 libavoid 的演算法(Inkscape / JointJS 在用),不是自創 heuristic
- 增量重算的想法來自同作者 "Incremental Connector Routing" (GD'05)

### 三步流程
1. **正交可視圖 (OVG, Orthogonal Visibility Graph)**
   - 每個 node 的 bounding box 向外擴 margin,四邊產生「有趣的水平/垂直線」
   - 加上每條 link 的端點(stub 點)座標
   - 所有線的交點 = 搜尋圖節點。**圖大小只跟 node 數量有關,跟畫布大小無關**
     (這就是為什麼舊的 grid A* 方案卡、這個不卡)
2. **A\* 搜尋**
   - 狀態 = `(交點, 進入方向)`,方向是 E/S/W/N(見 DIR 常數)
   - 成本 = 路徑長 + bendPenalty × 轉彎數
   - 啟發函數 = 曼哈頓距離 + bendPenalty × 剩餘最少轉彎數
     (轉彎估計表來自論文 Figure 2(a),實作在 `estBends()` — **這個函數是可採納的
     (admissible),改壞它 A\* 就不保證最優**)
   - 鄰居展開順序:直行 → 右轉 → 左轉(deterministic tie-break,行為可預測)
3. **繪製**:圓角折線(arcTo),見 smart-edge.js 的 `tracePath()`

### 關鍵設計:三層軟成本(不是硬阻擋!)
`build()` 給每條圖邊一個 tier:
- **tier 0** = 自由空間,成本 ×1
- **tier 1** = 在某 node 的 margin 區內(但不在 node 本體),成本 ×3
- **tier 2** = 在 node 本體內,成本 ×31(TIER_MULT = [0, 2, 30],乘的是額外成本)

**為什麼不用硬阻擋**:node 靠很近時,port 的 stub 點會落在鄰居的 margin 區內,
硬阻擋會把端點「困死」導致路由失敗。軟成本讓路由永遠成功,
且只有 node 真正重疊時線才會穿過 node 本體。
這是開發中實測發現的坑(硬阻擋版本 80 條線有 21 條失敗),改軟成本後 100% 成功。

### 另一個坑:stub 必須比 margin 長
`stubLen() = margin + 6`。stub 點(從 port 伸出的直線末端)必須落在自己 node 的
膨脹障礙框**外面**,否則起點被自己的框困住。改 margin 相關程式碼時務必保持這個關係。

### router.js API
```js
const router = new OrthoRouter({ margin: 16, bendPenalty: 40 });
// margin 可以是數字或 {l, r, t, b}
router.build(rawRects, terminals);
// rawRects: [{x, y, w, h}] 所有 node 的框(未膨脹,build 內部會膨脹)
// terminals: [{x, y}] 所有 stub 點 — 必須傳,否則端點不在圖上找不到路
const pts = router.route(stubOut, DIR.E, stubIn, DIR.E);
// 回傳 [{x, y}, ...] 或 null(找不到路,呼叫方用 fallbackPath)
```
- `route()` 有 60000 次 pop 的安全閥,超過回 null
- `simplify()` 去除共線點;`router.raw` 是未膨脹框(sticky path 碰撞檢查用)
- `debugInfo()` 回傳 `{rects, xs, ys}` 給 debug 覆蓋層

### 效能實測(60 nodes / 80 links 壓力測試)
- 建圖 ~11ms,單條 link A* 平均 1.8-2.5ms
- 全部重算最壞 ~200ms,但增量機制下拖一個 node 通常只重算 3-5 條線

---

## 3. ComfyUI 整合(smart-edge.js)

### Hook 方式
```js
const proto = LGraphCanvas.prototype;
const original = proto.drawConnections;
proto.drawConnections = function (ctx) {
  if (linksHidden(this)) return;              // 官方 hide links 優先
  if (!S.enabled) return original.call(this, ctx);
  if (drawAll(this, ctx) === false) return original.call(this, ctx);
};
```
- ctx 已被 LiteGraph 轉到 **graph space**,node.pos / getConnectionPos 同座標系
- `drawAll` 回傳 false = 退回官方畫線(出錯或含無法解析的 link)
- **routeAll 回傳 null = 這一幀退官方線但插件保持啟用**(subgraph 保底機制)

### 增量重算(防卡的核心)
- `layoutSignature()`:所有 node 的 id+位置+大小串成字串,沒變就直接用 cache
- 變了 → 重建 OVG,算出 dirty rects(變動 node 的新舊位置),
  只有「端點動了」或「cache 路徑撞到 dirty rect」的線才重算
- `pathCache`: Map<linkId, {ends, pts, sticky, segs, total}>
  - `segs/total` 是動畫用的預計算幾何(setCachedPath 裡算,每幀只做插值)

### 拖動防閃(path stickiness)
- 拖動中(= settleTimer 活著),端點移動的線先嘗試 `stretchPath()`:
  平移舊路徑的 stub 段、恢復正交性、檢查不撞 node 本體(用 router.raw)
  → 成功就保持舊形狀,失敗才真正重路由
- 佈局停止變化 180ms 後(settleTimer 到期),清掉所有 sticky 標記強制最優重算
- 這是 libavoid GD'05 的做法,解決「拖動時線在不同拓撲間閃來閃去」

### Subgraph 支援(重要!曾出 bug 兩次)
ComfyUI 新版 subgraph 的邊界接口是**虛擬節點**:
- `graph.inputNode`(id **-10**)/ `graph.outputNode`(id **-20**)
- **不在 `graph._nodes` 裡,`getNodeById()` 找不到**
- **沒有 `getConnectionPos()`**,port 座標在 `ioNode.slots[i].pos`
- 這些事實是直接 grep comfyui_frontend_package 1.45.20 的 minified 原始碼確認的
  (`class SubgraphIONodeBase`、`class SubgraphSlot`、`origin_id===-10`)

處理:`resolveNode()` 對 -10/-20 直接回傳 inputNode/outputNode;
`endpoints()` 對虛擬節點走 `ioSlotPos()`。
**保底**:任何 link 解析不到(unresolved > 0)或座標拿不到 → routeAll 回 null
→ 該幀整個 canvas 退官方線 → **線永遠不會消失**。

### Hover 偵測(曾出 bug)
`canvas.node_over` 在滑鼠移到 DOM widget(如 CLIP Text Encode 的文字欄)上時失效,
因為 canvas 收不到 pointer 事件。
解法:document 層級監聽 pointermove,存 `mouseClient`,
`hoverNodeId()` 自己把 client 座標轉 graph 座標
(`(client - rect.left) / ds.scale - ds.offset[0]`)做命中測試。

### 動畫系統
- 樣式:dots / pill / arrow / oval(canvas 路徑,沿線方向旋轉)/ dash(setLineDash)
- rAF 迴圈只在有動畫顯示時啟動(`ensureAnimLoop`),FPS 節流(預設 30)
- **run 偵測**:監聽 api 的 `execution_start` / `execution_success` /
  `execution_error` / `execution_interrupted` / `status`(queue_remaining===0)
  → run 時按設定暫停動畫(off,預設)/ 降 10fps(low)/ 照常(on)
  → 動畫暫停時若模式是 animated,畫**靜止箭頭**代替
- flowMode 三模式:animated / static(靜止箭嘴,零動畫開銷)/ none

### 設定系統(有幾個非顯而易見的坑)
- `SETTINGS` 表:key → [id, label, type, default, attrs?, options?]
- **id 格式 `LinkRouter.Section.Name`,中段 Section 會變成設定面板的分組標題,
  且分組按字母排序** — 所以分組名是刻意取的:
  General → Highlight → Line Corners → Lines → Marker Animation → Routing
  (Corners 改名 Line Corners、Animation 改名 Marker Animation 都是為了排序)
- **改設定 id = 該設定的已存值會丟失**(用戶回到預設),盡量不要改 id
- **onChange 在註冊時可能以 undefined 呼叫**(前端版本差異)——
  `applySetting()` 對 undefined/null 一律回退預設值,數值再加 `+v || 預設` 雙保險。
  這個坑曾造成「全部變直線」的嚴重 bug(margin 變 NaN → 建圖壞掉 → 全部 fallback)
- 註冊後要主動 `getSettingValue(id, def)` 讀持久值,不能依賴 onChange 時機
- color 型設定:部分前端回傳**不帶 # 的裸 hex**,applySetting 裡對 animColor
  做了正則補 #。色盤沒有「空值」狀態,所以拆成 animColorUse(開關)+ animColor(色盤)
- Reset 按鈕:custom type(function)在新前端可能渲染成普通列,
  onChange(true) 也會觸發 reset,兩條路都通
- `updateClearanceRows()`:per-side/uniform 切換時把不相關的滑桿變暗,
  是 best-effort DOM hack,前端改版可能失效但無害

### 浮動按鈕列
- 全 emoji:🔀 路由開關 / 🌊📐➖ 官方線型循環(寫入 Comfy.LinkRenderMode)/
  ✨➤◾ 流動模式循環 / ⚙️ 開設定 / 🐞 debug(預設隱藏)/ ✖ 關閉列 / ✥ 拖動把手
- 預設位置:右邊偏中間上一點(x = innerWidth-340, y = 38%)
- 位置和 debug 狀態存 localStorage key `linkrouter.state`(不走 ComfyUI 設定)
- 開設定面板:`app.extensionManager.dialog.showSettingsDialog({props:{defaultPanel:"LinkRouter"}})`
  → fallback command `Comfy.ShowSettingsDialog` + 延時點側欄 → 舊版 `app.ui.settings.show()`

### 官方 hide links 連動
`LinkRenderMode` 值:0=Straight, 1=Linear, 2=Spline, **3=Hidden**(LiteGraph.HIDDEN_LINK)。
`linksHidden()` 檢查 canvas.links_render_mode,是 Hidden 就直接 return 不畫。

---

## 4. 設定完整清單(預設值)

| 分組 | 設定 | 預設 | 備註 |
|---|---|---|---|
| General | Enabled | true | 總開關 |
| General | FloatingBar | true | 浮動列 |
| General | AAResetDefaults | - | Reset 按鈕(AA 前綴讓它排最上)|
| General | ZDebugButton | false | 🐞 按鈕;關掉時同步關 debug 模式 |
| Routing | ClearanceMode | uniform | uniform / per-side |
| Routing | Clearance(+Left/Right/Top/Bottom) | 16 | 範圍 4–120 |
| Routing | BendPenalty | 40 | 範圍 10–150,越高線越直 |
| Routing | DragStickiness | true | 拖動防閃 |
| Lines | Width | 3 | 範圍 1–16(官方 connections_width 預設 3)|
| Lines | SelectBoost | 1.35 | 選中變粗倍數 1–3 |
| Lines | Outline | true | 黑色半透明描邊(官方風格)|
| Lines | OutlineWidth | 4 | 0.5–16 |
| Lines | OutlineOpacity | 0.5 | 0.05–1 |
| Line Corners | Mode | per-line | per-line(全線統一半徑)/ per-corner / off |
| Line Corners | Radius | 8 | 0–24 |
| Highlight | HoverAnimation | true | hover 顯示流動 |
| Highlight | SelectHighlight | true | 選中高亮+其他線變暗 |
| Highlight | SelectAnimation | true | 選中的線也有流動 |
| Highlight | DimOpacity | 0.06 | 無關線透明度 0–0.6 |
| Marker Animation | Mode | animated | animated / static(靜止箭嘴)/ none |
| Marker Animation | Style | pill | dots/pill/arrow/oval/dash |
| Marker Animation | Size | 6 | 1–14 |
| Marker Animation | Spacing | 72 | 10–200 |
| Marker Animation | Speed | 60 | 10–240 px/s |
| Marker Animation | UseCustomColor | true | 關 = 自動用線色加深 30% |
| Marker Animation | Color | #ffffff | 色盤 |
| Marker Animation | MarkerOutline | true | 標記黑描邊 |
| Marker Animation | MarkerOutlineWidth | 4 | 0.5–16 |
| Marker Animation | MaxFPS | 30 | 5–60 |
| Marker Animation | WhileRunning | off | off(run 時停)/ low(10fps)/ on |

---

## 5. 開發歷程(為什麼是現在這個方案)

用戶之前試過 5 個方案全部失敗,教訓都很有價值:

| 版本 | 方案 | 失敗原因 |
|---|---|---|
| v0.1-0.5 | 均勻格子 + A*/JPS | 格子數跟畫布大小綁定(45,000 格),太卡 |
| v0.6 | 角點可視圖 + Dijkstra | 任意角度直線連角點 → 路徑全是直線,看不出有避障 |
| v0.7-0.9 | Web Worker + JPS | 非同步延遲 → 拖動時路徑落後 1-2 幀 |
| v0.10 | 純幾何上下繞 | 只會上下繞,node 靠近時彈跳 |
| v1.0-1.2 | Lane Router(自創)| 只有水平 lane,靈活度不足 |

**本次重寫(全新,未沿用舊碼)成功的關鍵**:
1. OVG 圖大小與畫布無關(解卡)
2. 只允許水平/垂直移動 → 天生正交路徑(解「看起來沒避」)
3. 主線程同步算 + 增量重算(解 Worker 延遲)
4. A* + 轉彎懲罰(解只會上下繞)
5. stickiness(解拖動閃爍)

---

## 6. 已知限制與未來 ComfyUI 更新時的 bug 排查指南

### 已知限制
- 兩個 node 直接重疊時,線會穿過 node 本體(tier-2 軟成本,刻意設計,無解也不需解)
- `updateClearanceRows()` 的變暗效果依賴 DOM 結構,前端改版可能失效(無害)
- 官方線型(Spline 等)只在 LinkRouter 關閉時生效,兩者互斥

### ComfyUI 更新後可能壞的點(按可能性排序)

1. **subgraph 虛擬節點結構又變**
   - 症狀:進 subgraph 線變官方樣式(保底觸發)或消失
   - 排查:F12 console 跑
     `app.canvas.graph.inputNode` 看結構、
     `[...app.canvas.graph.links.values()][0]` 看 origin_id 格式
   - 修法:更新 `resolveNode()` / `ioSlotPos()`;-10/-20 常數若變,
     grep 前端 assets 找 `origin_id===-` 確認新值
   - **保底機制保證線不會消失,只會退官方線,不緊急**

2. **drawConnections 簽名或呼叫方式變**
   - 症狀:完全沒有 LinkRouter 線(hook 沒生效)或報錯
   - 排查:console 看有沒有 `[LinkRouter]` 警告;
     `LGraphCanvas.prototype.drawConnections` 是否還存在
   - 注意:Comfy-Org 已把 litegraph.js merge 進 frontend repo,
     API 有逐步 TypeScript 化/改名的風險

3. **設定 API 變**(addSetting / getSettingValue / setSettingValue)
   - 症狀:設定不見、值全部回預設、console 報 addSetting failed
   - 已有 try/catch 保護,插件會用預設值繼續跑

4. **api 事件名變**(execution_start 等)
   - 症狀:run 時動畫沒停
   - 排查:`api.addEventListener` 是否還收到事件;低嚴重度

5. **getConnectionPos / getBounding 行為變**
   - 症狀:線的端點位置錯、障礙框對不齊(開 🐞 debug 看紅框)
   - `nodeRect()` 用 `node.getBounding(Float32Array)`,包含 title bar

6. **`canvas.ds`(DragAndScale)結構變**
   - 症狀:hover 動畫位置錯亂或不觸發
   - hoverNodeId() 用 `ds.scale` 和 `ds.offset[0/1]` 做座標轉換

### Debug 工具
- 浮動列 🐞(需在設定開 ZDebugButton):紅框 = 膨脹障礙框,藍點 = 路徑 waypoints
- console 過濾 `[LinkRouter]` — 所有內部失敗都有 warning,不會無聲退化
- `node test/router.test.mjs` — 演算法回歸測試(23 個測試,含效能斷言),
  **改 router.js 後必跑**;測試不依賴 ComfyUI,純 Node.js

---

## 7. 發佈準備(未完成事項)

- [ ] **改名**:候選 ComfyUI-LinkRouter / ComfyUI-CleanLinks / ComfyUI-Detour /
      ComfyUI-SmartLinks(LinkRouter 與 react-flow-smart-edge 撞名)。
      改名要動:資料夾名、SETTINGS id 前綴(**會丟用戶已存設定**,發佈前改一次就好)、
      registerExtension name、localStorage key、pyproject.toml
- [ ] **README.md**:功能 GIF、安裝(git clone 到 custom_nodes)、設定說明、Credits
- [ ] **LICENSE**:建議 **MIT**(生態標準)。演算法來自公開論文,
      程式碼全部原創(未使用 libavoid 程式碼,不受其 LGPL 約束),
      論文引用放 README Credits(學術禮貌,非法律義務)
- [ ] **pyproject.toml**(ComfyUI Registry / Manager 收錄用):
  ```toml
  [project]
  name = "comfyui-xxx"
  version = "1.0.0"
  description = "Object-avoiding orthogonal link routing for ComfyUI"
  license = { file = "LICENSE" }
  [tool.comfy]
  PublisherId = "<github用戶名>"
  DisplayName = "XXX"
  ```
- [ ] screenshots/demo.gif(強烈建議,轉化率差很多)

### Credits 素材(寫 README 用)
- 演算法:M. Wybrow, K. Marriott, P.J. Stuckey,
  "Orthogonal Connector Routing", Graph Drawing 2009, LNCS 5849
- 增量重路由概念:同作者 "Incremental Connector Routing", GD 2005
- 靈感/同類:libavoid (Adaptagrams)、react-flow-smart-edge、JointJS
- 全部程式碼原創實作(JavaScript),無第三方依賴

---

## 8. 給接手的 AI/開發者的快速上手

1. 先讀 `web/router.js`(~300 行,純演算法)再讀 `web/smart-edge.js`(~1100 行,整合)
2. 兩個檔案開頭都有大段註解說明架構
3. 改 router.js 後跑 `node test/router.test.mjs`(必須 23/23)
4. 改 smart-edge.js 後跑 `node --check web/smart-edge.js` + 瀏覽器實測
5. 用戶的驗收習慣:Ctrl+R 重載前端,拖 node 看順不順、看線有沒有避開、
   進 subgraph 檢查、開 🐞 看障礙框
6. **用戶偏好(重要)**:先討論方案再動手;繁體中文回覆;
   不要擅自擴大改動範圍;設定要做成可調選項而不是寫死;
   出過的 bug 要跟他解釋根因

### 歷次真實 bug 清單(修過的,勿再犯)
1. 設定 onChange 收到 undefined → margin NaN → 全部直線(修:undefined 回退預設)
2. 設定 id 用數字前綴排序 → 面板顯示 "0 1 2 3" 分組(修:改英文分組名)
3. hover 在 DOM widget 上不觸發(修:document 層級追蹤 + 自己命中測試)
4. 色盤回傳裸 hex 少 `#`(修:正則補 #)
5. subgraph 邊界線消失(修 v1:getNodeById fallback — 不夠;
   修 v2:直接比對 -10/-20 + slots[].pos 拿座標 + unresolved 保底)
6. 硬阻擋把 port 困死 → 路由失敗(修:三層軟成本)
7. stub 比 margin 短 → 起點困在自己的障礙框內(修:stubLen = margin + 6)
8. 動畫每幀重算線段幾何 → 浪費(修:setCachedPath 預計算 segs/total)
```
