import { newCut, reindexCuts, invalidateTimelineReview, invalidatePreviewReview } from "./model.js";

export const SIMPLE_V2_SCHEMA_VERSION = 6;
export const SIMPLE_V2_PARENT_COUNT = 12; // legacy/default only; new episodes may use any storyboard count
export const SIMPLE_V2_MAX_STORYBOARD_COUNT = 200;
export const SIMPLE_V2_STEPS = Object.freeze([
  { key: "story", route: "simple", label: "① 스토리" },
  { key: "audio", route: "simpleAudio", label: "② 오디오" },
  { key: "timeline", route: "simpleTimeline", label: "③ 타임라인" },
  { key: "preview", route: "simplePreview", label: "④ 미리보기" },
  { key: "export", route: "simpleExport", label: "⑤ 내보내기" },
]);

function newParent(index) {
  return { id: String(index), index, label: "", narration: "", prompt: "", imageAssetId: null, imageMeta: null, videoAssetId: null, videoMeta: null, visualRole: null, children: [] };
}

function fixedOutputForFormat(contentFormat) {
  const longform = contentFormat === "longform";
  return { aspect: longform ? "16:9" : "9:16", width: longform ? 1920 : 1080, height: longform ? 1080 : 1920 };
}

export function newSimpleProductionV2(contentFormat = "shorts") {
  return {
    schemaVersion: SIMPLE_V2_SCHEMA_VERSION,
    contentFormat: contentFormat === "longform" ? "longform" : "shorts",
    storyboardVersion: 1, storyboardCount: SIMPLE_V2_PARENT_COUNT, storyboardMode: "legacy_master12", scriptVersion: 1, scriptProvider: "GPT", scriptText: "", claudeRevisionRequest: "",
    thumbnailNotes: "", commonVisualNote: "", masterStoryboardAssetId: null, masterStoryboardMeta: null, finalVideoAssetId: null, finalVideoMeta: null, outputAspectRatio: contentFormat === "longform" ? "16:9" : "9:16", outputFitMode: "cover",
    parents: Array.from({ length: SIMPLE_V2_PARENT_COUNT }, (_, i) => { const p = newParent(i + 1); if (contentFormat === "longform") p.children = Array.from({ length: 4 }, (_, childIndex) => normalizeChild({}, i + 1, childIndex + 1)); return p; }),
    lockedAt: null, lockedStoryboardVersion: null, lockedScriptVersion: null, createdAt: Date.now(), updatedAt: Date.now(),
  };
}

export function ensureSimpleProductionV2(ep) {
  if (!ep || typeof ep !== "object") return ep;
  ep.productionWorkflow = "simple_v2";
  if (!ep.simpleProductionV2 || typeof ep.simpleProductionV2 !== "object") ep.simpleProductionV2 = newSimpleProductionV2(ep.contentFormat);
  const state = ep.simpleProductionV2;
  state.schemaVersion = SIMPLE_V2_SCHEMA_VERSION;
  state.contentFormat = ep.contentFormat === "longform" ? "longform" : "shorts";
  if (!Number.isFinite(Number(state.storyboardVersion))) state.storyboardVersion = 1;
  if (!Number.isFinite(Number(state.storyboardCount))) state.storyboardCount = Math.max(1, state.parents?.length || SIMPLE_V2_PARENT_COUNT);
  state.storyboardCount = Math.min(SIMPLE_V2_MAX_STORYBOARD_COUNT, Math.max(1, Math.round(Number(state.storyboardCount) || SIMPLE_V2_PARENT_COUNT)));
  if (typeof state.storyboardMode !== "string") state.storyboardMode = state.storyboardCount === 12 ? "legacy_master12" : "variable_beats";
  if (!Number.isFinite(Number(state.scriptVersion))) state.scriptVersion = 1;
  if (typeof state.scriptProvider !== "string") state.scriptProvider = "GPT";
  if (typeof state.scriptText !== "string") state.scriptText = "";
  if (typeof state.claudeRevisionRequest !== "string") state.claudeRevisionRequest = "";
  if (typeof state.thumbnailNotes !== "string") state.thumbnailNotes = "";
  if (typeof state.commonVisualNote !== "string") state.commonVisualNote = "";
  if (state.masterStoryboardAssetId === undefined) state.masterStoryboardAssetId = null;
  if (state.masterStoryboardMeta === undefined) state.masterStoryboardMeta = null;
  if (state.finalVideoAssetId === undefined) state.finalVideoAssetId = null;
  if (state.finalVideoMeta === undefined) state.finalVideoMeta = null;

  const fixed = fixedOutputForFormat(state.contentFormat);
  state.outputAspectRatio = fixed.aspect;
  state.outputFitMode = "cover";
  ep.renderSettings = { ...(ep.renderSettings || {}), width: fixed.width, height: fixed.height };
  ep.outputFitMode = "cover";

  if (!Array.isArray(state.parents)) state.parents = [];
  const oldByIndex = new Map(state.parents.map((p) => [Number(p?.index), p]));
  state.parents = Array.from({ length: state.storyboardCount }, (_, i) => {
    const index = i + 1;
    const p = oldByIndex.get(index) || newParent(index);
    p.id = String(index); p.index = index;
    if (typeof p.label !== "string") p.label = "";
    if (typeof p.narration !== "string") p.narration = "";
    if (typeof p.prompt !== "string") p.prompt = "";
    if (p.imageAssetId === undefined) p.imageAssetId = null;
    if (p.imageMeta === undefined) p.imageMeta = null;
    if (p.videoAssetId === undefined) p.videoAssetId = null;
    if (p.videoMeta === undefined) p.videoMeta = null;
    if (p.visualRole === undefined) p.visualRole = null;
    if (!Array.isArray(p.children)) p.children = [];
    if (state.storyboardMode === "legacy_master12" && state.contentFormat === "longform" && p.children.length === 0) p.children = Array.from({ length: 4 }, (_, childIndex) => normalizeChild({}, index, childIndex + 1));
    p.children = p.children.map((child, childIndex) => normalizeChild(child, index, childIndex + 1));
    return p;
  });
  // LEGACY DATA MIGRATION: episodes created by the Economy Rate V3 loader (marker finalPassVersion===1)
  // relied on a hardcoded 32-beat reuse rule. Persist it as data once; nothing else is affected.
  if (state.finalPassVersion === 1 && state.parents.length >= 30) {
    if (state.parents[13].reuseImageFrom === undefined) state.parents[13].reuseImageFrom = 13;
    if (state.parents[29].reuseImageFrom === undefined) state.parents[29].reuseImageFrom = 5;
  }
  repairSimplePanelImageOrder(state);
  if (state.lockedAt === undefined) state.lockedAt = null;
  if (state.lockedStoryboardVersion === undefined) state.lockedStoryboardVersion = null;
  if (state.lockedScriptVersion === undefined) state.lockedScriptVersion = null;
  if (!state.createdAt) state.createdAt = Date.now();
  state.updatedAt = Date.now();
  return ep;
}

function normalizeChild(child, parentIndex, order) {
  const out = child && typeof child === "object" ? child : {};
  out.order = order; out.id = `${parentIndex}-${order}`;
  if (typeof out.prompt !== "string") out.prompt = "";
  if (typeof out.narration !== "string") out.narration = "";
  if (out.imageAssetId === undefined) out.imageAssetId = null;
  if (out.imageMeta === undefined) out.imageMeta = null;
  if (out.videoAssetId === undefined) out.videoAssetId = null;
  if (out.videoMeta === undefined) out.videoMeta = null;
  if (out.mediaType !== "video" && out.mediaType !== "image") out.mediaType = out.videoAssetId ? "video" : "image";
  return out;
}


export function resizeSimpleStoryboard(ep, requestedCount) {
  ensureSimpleProductionV2(ep);
  const state = ep.simpleProductionV2;
  const count = Math.min(SIMPLE_V2_MAX_STORYBOARD_COUNT, Math.max(1, Math.round(Number(requestedCount) || state.parents.length || SIMPLE_V2_PARENT_COUNT)));
  if (count === state.parents.length && state.storyboardMode === "variable_beats") return state.parents;
  const previous = state.parents.slice();
  state.storyboardMode = "variable_beats";
  state.storyboardCount = count;
  state.parents = Array.from({ length: count }, (_, i) => {
    const index = i + 1;
    const p = previous[i] || newParent(index);
    p.id = String(index); p.index = index;
    if (!Array.isArray(p.children)) p.children = [];
    const hasMeaningfulChildren = p.children.some((child) => child?.imageAssetId || child?.videoAssetId || String(child?.narration || "").trim() || String(child?.prompt || "").trim());
    if (!hasMeaningfulChildren) p.children = [];
    p.children = p.children.map((child, childIndex) => normalizeChild(child, index, childIndex + 1));
    return p;
  });
  state.storyboardVersion = Math.max(1, Number(state.storyboardVersion) || 1) + 1;
  state.updatedAt = Date.now();
  return state.parents;
}

export function applyEconomyRateV3Storyboard(ep) {
  resizeSimpleStoryboard(ep, 32);
  const state=ep.simpleProductionV2;
  const rows=[
    ["같은 은행, 다른 출발","같은 은행에서 똑같이 3억원을 빌린 두 사람이 있습니다. A의 금리는 4.1%. B의 금리는 4.5%.","VIDEO"],
    ["A 4.1% / B 4.5%","차이는 겨우 0.4%포인트입니다.","STILL"],
    ["0.4%p의 실제 크기","그런데 3억원에 붙이면 이야기가 달라집니다. 단순 이자만 따져도 1년에 120만원. 한 달이면 약 10만원입니다.","TRACKER GRAPHIC"],
    ["월 10만원의 생활비","같은 은행에서 비슷한 돈을 빌렸는데, 한 사람은 매달 10만원을 더 냅니다.","STILL"],
    ["같은 기준금리 뉴스","그런데 진짜 이상한 일은 지금부터입니다. 2026년 8월 27일. 한국은행이 기준금리를 3%로 올렸습니다. A와 B도 같은 뉴스를 봤습니다.","VIDEO"],
    ["A만 먼저 바뀐다","그런데 A에게는 대출금리가 바뀐다는 안내가 옵니다. B는? 아무 일도 없습니다.","STILL"],
    ["같은 조건, 다른 결과","같은 뉴스. 같은 은행. 비슷한 대출. 그런데 금리도 다르고, 움직이는 날짜도 다릅니다. 대체 어디서 갈라진 걸까요?","TRACKER GRAPHIC"],
    ["3억원을 거꾸로 추적","3%라는 숫자를 들고 A가 빌린 3억원을 거꾸로 따라가 보겠습니다.","VIDEO"],
    ["돈의 이동 경로","은행이 A에게 3억원을 빌려줬습니다. 그런데 그 돈은 은행 금고에서 공짜로 꺼낸 돈이 아닙니다. 누군가 맡긴 예금일 수도 있고, 은행이 시장에서 조달한 돈일 수도 있습니다.","MOTION"],
    ["은행도 돈을 산다","은행도 돈을 구하려면 돈을 냅니다. 쉽게 말하면, 은행에도 돈의 원가가 있다는 얘기입니다.","STILL"],
    ["기준금리 3% ≠ 내 금리","여기서 첫 번째 착각이 깨집니다. 한국은행 기준금리 3%. 이건 은행이 모든 돈을 정확히 3%에 가져온다는 뜻이 아닙니다.","TRACKER GRAPHIC"],
    ["중간 다리","그래서 대출상품을 보면 COFIX나 금융채 같은 기준이 등장합니다. 은행이 돈을 조달하는 비용과 시장 상황이 내 대출금리로 넘어오는 중간 다리입니다.","TRACKER GRAPHIC"],
    ["다시 A/B 계약서","그런데 여기서 또 이상합니다. 은행의 돈값이 비슷하다면 A와 B의 금리도 비슷해야 하지 않을까요? 다시 두 사람의 계약서를 열어보겠습니다.","VIDEO"],
    ["4.1%와 4.5% 분해","A 4.1%. B 4.5%. 이번에는 이 4%대를 뜯어보겠습니다.","TRACKER GRAPHIC"],
    ["최종금리 공식","대출금리는 기준이 되는 금리에 무언가 더해지고, 조건에 따라 일부가 빠지는 구조입니다. 가산금리가 붙고, 상품별 우대조건을 충족하면 우대금리가 적용됩니다.","TRACKER GRAPHIC"],
    ["우대조건 발견","여기서 B가 계약서를 다시 봅니다. 그리고 그냥 지나쳤던 항목 하나를 발견합니다. 우대조건.","STILL"],
    ["생활 속 우대조건","급여이체, 카드 사용, 자동이체처럼 상품마다 정해놓은 조건들이 있습니다. 어떤 조건에 얼마를 우대하는지는 상품마다 다릅니다.","STILL"],
    ["0.4%p → 120만원","아까 그 0.4%포인트를 다시 가져와 보겠습니다. 3억원이면 연 120만원. 한 달 약 10만원.","MOTION"],
    ["10만원이 생활비가 된다","0.4라는 숫자로 보면 작습니다. 그런데 통장에서 빠져나가는 돈으로 바꾸면 휴대전화 요금이 될 수도 있고, 관리비 일부가 될 수도 있고, 한 번의 장보기가 될 수도 있습니다.","VIDEO"],
    ["남은 미스터리","그런데 아직 첫 번째 미스터리의 절반밖에 해결하지 못했습니다. 왜 A의 금리는 움직였는데, B는 그대로였을까요?","TRACKER GRAPHIC"],
    ["범인은 날짜","둘 다 변동금리 대출이라고 해보겠습니다. 여기서 범인은 금리가 아니라 날짜입니다. 계약에서 정한 주기에 따라 금리를 다시 계산하는 시점이 옵니다.","VIDEO"],
    ["같은 신호, 다른 도착","A의 차례가 먼저 왔습니다. B의 차례는 아직입니다. 같은 뉴스가 사람마다 다른 날짜에 도착하는 셈입니다.","TRACKER GRAPHIC"],
    ["A 통장만 먼저 변화","A의 통장은 먼저 움직이고, B의 통장은 아직 조용할 수 있습니다.","STILL"],
    ["B의 안도와 다음 날짜","그러면 B는 안심해도 될까요? 아닙니다. 아직 자기 차례가 오지 않은 것일 수도 있습니다.","VIDEO"],
    ["4.5 → 4.2 발견","이제 B가 휴대폰을 다시 봅니다. 검색해보니 지금은 4.5%. 다른 상품은 4.2%. 0.3%포인트나 낮습니다.","STILL"],
    ["갈아타기 직전","바로 바꾸면 이득처럼 보입니다. 그런데 여기에도 함정이 하나 있습니다.","VIDEO"],
    ["금리차 ≠ 실제이익","우리가 비교해야 하는 건 4.5와 4.2, 숫자 두 개만이 아닙니다.","TRACKER GRAPHIC"],
    ["절감이자 vs 비용","앞으로 실제로 줄어드는 이자와 대출을 바꾸면서 들어가는 비용을 함께 봐야 합니다.","TRACKER GRAPHIC"],
    ["질문을 바꾼다","그래서 질문을 바꿔야 합니다. 몇 퍼센트 더 싸지? 가 아니라, 그래서 끝까지 계산하면 내 통장에 얼마가 남지?","TRACKER GRAPHIC"],
    ["처음으로 돌아가기","이제 처음으로 돌아가겠습니다. 한국은행 기준금리 뉴스에서 다시 출발합니다.","VIDEO"],
    ["3%에서 내 통장까지","3%에서 출발한 신호가 은행이 돈을 구하는 비용을 지나고, 내 상품의 기준금리를 지나고, 가산금리와 우대금리를 지나고, 내 계약의 재산정 날짜를 지나서, 마지막에야 내 통장에 도착합니다.","TRACKER GRAPHIC"],
    ["내 계약의 네 가지","다음에 기준금리 뉴스가 나오면 네 가지를 꺼내보세요. 내 대출이 무엇을 기준으로 움직이는지. 가산금리와 우대조건은 무엇인지. 다음 재산정일은 언제인지. 그리고 지금 실제 적용받는 금리는 얼마인지. 뉴스는 모두에게 같은 숫자를 보여주지만 그 숫자가 내 통장까지 오는 길은 사람마다 다릅니다.","STILL"]
  ];
  const finalRoles={9:"TRACKER MOTION",13:"STILL",14:"STILL",18:"STILL MOTION",19:"VIDEO+STILL",21:"STILL MOTION",24:"STILL MOTION",30:"STILL CALLBACK",32:"STILL ENDING"};
  const finalMotion={4:"PUSH_IN_SLOW",5:"PUSH_IN_SLOW",13:"PUSH_IN_SLOW",18:"PUSH_IN_SLOW",21:"PUSH_IN_SLOW",24:"PUSH_IN_SLOW",30:"PUSH_IN_SLOW",32:"ENDING_FOUR_STAGE"};
  const finalDurations=[7.706,2.725,8.442,5.454,11.224,7.938,12.497,6.966,8.704,5.488,13.382,9.034,7.992,5.670,27.022,7.040,15.008,7.846,19.707,3.707,17.325,16.379,6.052,7.834,10.156,8.655,6.890,13.446,8.729,11.731,20.454,28.230];
  rows.forEach((r,i)=>{const p=state.parents[i]; const beat=i+1; p.label=r[0]; p.narration=r[1]; p.visualRole=finalRoles[beat]||r[2]; p.finalDuration=finalDurations[i]; p.motionPreset=finalMotion[beat]||"STATIC"; p.overlayCues=null; if(r[2]==="TRACKER GRAPHIC") p.prompt=`[TRACKER_GRAPHIC] ${r[0]}`;});
  // Reuse is stored as Episode data on the parents that need it (Beat 14 <- 13, Beat 30 <- 5).
  state.parents[13].reuseImageFrom=13; state.parents[29].reuseImageFrom=5;
  state.finalPassVersion=1;
  state.masterDuration=349.433;
  state.positionLock={A:"left",B:"right"};
  state.flowTrim={1:{start:0,end:7.706},8:{start:0,end:6.966},19:{start:0,end:6},26:{start:0,end:8.655}};
  state.transitionLock={default:"HARD_CUT",connectiveBeats:[8,18,30]};
  state.storyboardMode="variable_beats"; state.storyboardCount=32; state.storyboardVersion=Math.max(1,Number(state.storyboardVersion)||1)+1; state.updatedAt=Date.now(); return state.parents;
}

export function addSimpleChild(ep, parentIndex) {
  ensureSimpleProductionV2(ep); const parent = ep.simpleProductionV2.parents[parentIndex - 1]; if (!parent) return null;
  const child = normalizeChild({}, parentIndex, parent.children.length + 1); parent.children.push(child); ep.simpleProductionV2.updatedAt = Date.now(); return child;
}
export function removeSimpleChild(ep, parentIndex, childId) {
  ensureSimpleProductionV2(ep); const parent = ep.simpleProductionV2.parents[parentIndex - 1]; if (!parent) return;
  parent.children = parent.children.filter((child) => child.id !== childId).map((child, i) => normalizeChild(child, parentIndex, i + 1)); ep.simpleProductionV2.updatedAt = Date.now();
}
export function moveSimpleChild(ep, parentIndex, childId, delta) {
  ensureSimpleProductionV2(ep); const parent = ep.simpleProductionV2.parents[parentIndex - 1]; if (!parent) return;
  const from = parent.children.findIndex((child) => child.id === childId); const to = from + delta;
  if (from < 0 || to < 0 || to >= parent.children.length) return;
  const [item] = parent.children.splice(from, 1); parent.children.splice(to, 0, item); parent.children = parent.children.map((child, i) => normalizeChild(child, parentIndex, i + 1)); ep.simpleProductionV2.updatedAt = Date.now();
}

// 2026-09 경제그루터기 파일럿 12장. Android 사진 선택기는 파일명을 임의 이름으로
// 바꿔 넘길 수 있어, 정확히 이 12개 원본이 함께 들어온 경우에만 바이트 크기로 번호를 복구한다.
// 04와 06은 의도적으로 동일 이미지라 동일 크기이며 첫 번째/두 번째를 각각 04/06으로 쓴다.
const PILOT_PANEL_SIZE_SLOTS = new Map([
  [214354, [1]],
  [266507, [2]],
  [197554, [3]],
  [172263, [4, 6]],
  [227706, [5]],
  [267664, [7]],
  [217600, [8]],
  [249524, [9]],
  [244919, [10]],
  [185462, [11]],
  [187967, [12]],
]);

function inferKnownPilotSlots(items, sizeReader) {
  const list = Array.from(items || []);
  if (list.length !== SIMPLE_V2_PARENT_COUNT) return null;
  const useCount = new Map();
  const slots = [];
  for (const item of list) {
    const size = Number(sizeReader(item));
    const candidates = PILOT_PANEL_SIZE_SLOTS.get(size);
    if (!candidates) return null;
    const used = useCount.get(size) || 0;
    if (used >= candidates.length) return null;
    slots.push(candidates[used]);
    useCount.set(size, used + 1);
  }
  return new Set(slots).size === SIMPLE_V2_PARENT_COUNT ? slots : null;
}

export function mapPanelFiles(files, storyboardCount = SIMPLE_V2_PARENT_COUNT) {
  const list = Array.from(files || []);
  const count = Math.min(SIMPLE_V2_MAX_STORYBOARD_COUNT, Math.max(1, Math.round(Number(storyboardCount) || SIMPLE_V2_PARENT_COUNT)));
  const fingerprintSlots = count === SIMPLE_V2_PARENT_COUNT ? inferKnownPilotSlots(list, (file) => file?.size) : null;
  const rows = list.map((file, order) => ({
    file,
    order,
    slot: fingerprintSlots?.[order] || inferPanelNumber(file?.name),
    source: fingerprintSlots ? "content-fingerprint" : "filename",
  }));
  const duplicates = new Set(rows.filter((row) => row.slot && rows.filter((x) => x.slot === row.slot).length > 1).map((row) => row.slot));
  const used = new Set(rows.map((row) => row.slot).filter((n) => n >= 1 && n <= count && !duplicates.has(n)));
  const remaining = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !used.has(n));
  rows.forEach((row) => { if (!(row.slot >= 1 && row.slot <= count) || duplicates.has(row.slot)) { row.slot = remaining.shift() || null; row.source = "selection-order"; } });
  return rows;
}
function inferPanelNumber(name) {
  const base = String(name || "").replace(/\.[^.]+$/, "");
  const explicit = base.match(/(?:^|[^0-9])(?:panel|scene|cut|img|image)?[ _-]*0*([1-9][0-9]{0,2})(?:[^0-9]|$)/i);
  if (explicit) return Number(explicit[1]);
  const plain = base.match(/^0*([1-9][0-9]{0,2})$/); return plain ? Number(plain[1]) : null;
}

// 저장된 기존 배치도 로드 시 자동 복구한다. 파일명이 유지되면 번호를 우선 사용하고,
// Android가 이름을 바꿨더라도 이번 파일럿 원본 12장이 그대로 있으면 크기로 복구한다.
function repairSimplePanelImageOrder(state) {
  if (!state || !Array.isArray(state.parents) || state.parents.length !== SIMPLE_V2_PARENT_COUNT) return false;
  const currentSignature = state.parents.map((p) => String(p?.imageAssetId || "")).join("|");
  if (state.panelImageOrderManualSignature && state.panelImageOrderManualSignature === currentSignature) return false;
  const filled = state.parents.filter((p) => p?.imageAssetId);
  if (filled.length !== SIMPLE_V2_PARENT_COUNT) return false;

  let slots = filled.map((p) => inferPanelNumber(p.imageMeta?.fileName));
  const nameSlotsValid = slots.every((n) => n >= 1 && n <= SIMPLE_V2_PARENT_COUNT) && new Set(slots).size === SIMPLE_V2_PARENT_COUNT;
  if (!nameSlotsValid) slots = inferKnownPilotSlots(filled, (p) => p.imageMeta?.sizeBytes);
  if (!slots) return false;

  const bySlot = new Map(filled.map((parent, i) => [slots[i], { imageAssetId: parent.imageAssetId, imageMeta: parent.imageMeta }]));
  if (bySlot.size !== SIMPLE_V2_PARENT_COUNT) return false;
  let changed = false;
  state.parents.forEach((parent, i) => {
    const expected = bySlot.get(i + 1);
    if (!expected) return;
    if (parent.imageAssetId !== expected.imageAssetId) changed = true;
    parent.imageAssetId = expected.imageAssetId;
    parent.imageMeta = expected.imageMeta;
  });
  if (changed) state.panelImageOrderRepairedAt = Date.now();
  return changed;
}

export function buildGeminiPacket(ep, parentIndex, childId = null) {
  ensureSimpleProductionV2(ep); const state = ep.simpleProductionV2; const parent = state.parents[parentIndex - 1]; if (!parent) return "";
  const child = childId ? parent.children.find((x) => x.id === childId) : null; const prompt = String(child?.prompt || parent.prompt || "").trim(); const narration = String(child?.narration || parent.narration || "").trim(); const targetLabel = child ? `세부 장면 ${child.id}` : `MASTER 장면 ${parent.index}`;
  return [
    `이 이미지는 ${state.parents.length}장 스토리보드의 ${parent.index}번 장면을 레퍼런스로 사용합니다.`,  `현재 제작 대상은 ${targetLabel}입니다.`,
    `최종 이미지 화면비: ${state.contentFormat === "longform" ? "반드시 16:9 가로형 YouTube Longform, 1920×1080 기준. 9:16 세로형 및 1:1 정사각형 절대 금지" : "9:16 세로"}. 처음부터 최종 비율로 새로 구성하고 기존 이미지를 늘여 변형하지 마세요.`,
    state.contentFormat === "longform" ? "모바일에서도 핵심 내용이 한눈에 보이도록 중심 피사체를 충분히 크게 배치하고, 좌우·상하 안전 여백을 확보하세요. 이미지 안에 제목·자막·설명문·숫자 라벨 등 임의 텍스트를 넣지 마세요. Tracker에서 별도로 넣을 그래픽/텍스트도 미리 그리지 마세요. 한 장면에는 이 Beat의 핵심 의미 하나만 명확히 표현하고, 불필요한 장식보다 상황 전달을 우선하세요." : "",
    "첨부한 MASTER 패널의 핵심 상황·구도·캐릭터·색감·메시지를 유지하되, 불필요하게 새 설정을 추가하지 마세요.",
    state.commonVisualNote ? `공통 비주얼 기준: ${state.commonVisualNote}` : "", prompt ? `제작 지시: ${prompt}` : "제작 지시: MASTER 패널의 메시지를 그대로 선명하게 완성 이미지로 제작하세요.",
    narration ? `이 장면의 나레이션: ${narration}` : "", "한 번에 이미지 1장만 생성하세요.",
  ].filter(Boolean).join("\n");
}

export function buildClaudePacket(ep) {
  ensureSimpleProductionV2(ep); const state = ep.simpleProductionV2; const storyboardSummary = state.parents.map((p) => `${p.index}. ${p.label || "장면"} — ${p.narration || "나레이션 미입력"}`).join("\n");
  return [
    `제목: ${ep.title || "제목 미정"}`, ep.thumbnail?.headline ? `썸네일 약속: ${ep.thumbnail.headline}${ep.thumbnail.subline ? ` / ${ep.thumbnail.subline}` : ""}` : "",
    `스토리보드 버전: v${state.storyboardVersion}`, `대본 버전: v${state.scriptVersion}`, `첨부한 ${state.parents.length}장 스토리보드를 최우선 기준으로 대본을 수정하세요.`, 
    state.claudeRevisionRequest ? `수정 요청: ${state.claudeRevisionRequest}` : "수정 요청: 기승전결, 장면 연결, 반복 제거, 더빙 자연스러움을 개선하되 스토리보드 순서를 임의 변경하지 마세요.",
    `\n[${state.parents.length}장 장면 요약]`, storyboardSummary, "\n[현재 전체 대본]", state.scriptText || "(대본 미입력)", "\n수정 결과는 완성 대본만 먼저 제시하고, 중요한 변경점은 마지막에 짧게 정리하세요.",
  ].filter(Boolean).join("\n");
}

export function validateSimpleProduction(ep) {
  ensureSimpleProductionV2(ep); const state = ep.simpleProductionV2; const warnings = [];
  if (!String(ep.title || "").trim()) warnings.push({ code: "missing-title", message: "제목이 비어 있습니다." });
  const variable = state.storyboardMode === "variable_beats";
  if (!variable && !state.masterStoryboardAssetId) warnings.push({ code: "missing-master-board", message: `${state.parents.length}장 스토리보드 원본이 아직 없습니다.` });
  if (!variable) { const missingParents = state.parents.filter((p) => !p.imageAssetId).map((p) => p.index); if (missingParents.length) warnings.push({ code: "missing-parent-images", message: `MASTER 개별 이미지 ${missingParents.length}장 미등록 (${missingParents.join(", ")})` }); }
  if (!String(state.scriptText || "").trim()) warnings.push({ code: "missing-script", message: "전체 대본이 비어 있습니다." });
  if (state.contentFormat === "longform" && !variable) {
    const sparse = state.parents.filter((p) => p.children.length < 4).map((p) => p.index); if (sparse.length) warnings.push({ code: "longform-child-count", message: `롱폼 세부 장면이 4개 미만인 MASTER: ${sparse.join(", ")} (권장만, 진행 차단 아님)` });
    const missingChildVisuals = state.parents.flatMap((p) => p.children.filter((c) => !c.imageAssetId && !c.videoAssetId && !p.imageAssetId).map((c) => c.id));
    if (missingChildVisuals.length) warnings.push({ code: "missing-child-media", message: `세부 장면 미디어 ${missingChildVisuals.length}개 미등록` });
  }
  if (!ep.masterNarration?.assetId) warnings.push({ code: "missing-audio", message: "CapCut 통합 나레이션이 아직 없습니다." }); return warnings;
}


// Variable-beat longform bridge:
// The user works with one full narration + N storyboard images. In this mode there
// should never be a second manual job of pasting narration into every MASTER scene.
// Split the full script into N contiguous sentence blocks, weighted as evenly as
// possible by character count, and persist those blocks on the MASTER parents.
// Existing non-empty parent narration is respected unless force=true.
function splitNarrationByStoryAnchors(script, anchorGroups) {
  const text = String(script || "").trim();
  if (!text || !Array.isArray(anchorGroups) || !anchorGroups.length) return null;
  const starts = [0];
  let cursor = 0;
  for (let i = 1; i < anchorGroups.length; i++) {
    const variants = anchorGroups[i] || [];
    let found = -1;
    for (const phrase of variants) {
      const pos = text.indexOf(phrase, cursor + 1);
      if (pos >= 0 && (found < 0 || pos < found)) found = pos;
    }
    if (found < 0) return null;
    starts.push(found);
    cursor = found;
  }
  starts.push(text.length);
  return anchorGroups.map((_, i) => text.slice(starts[i], starts[i + 1]).trim());
}

function seniorPilot30Segments(script) {
  // Exact semantic boundaries for the current 30-image senior-longform pilot.
  // Anchors are the first narration words that belong to the NEXT image.
  const anchors = [
    ["일흔한 살 이정희 씨는 매달 같은 날이면 은행에 갔습니다."],
    ["은행을 나온 정희 씨는 집으로 가는 길에 시장에 들렀습니다."],
    ["집으로 돌아와 고등어 반쪽을 굽고 콩나물국을 데우려는데 전화가 왔습니다."],
    ["잠시 후 서연이가 집에 왔습니다."],
    ["그러자 서연이가 아무 생각 없이 말했습니다."],
    ["그날 저녁."],
    ["다음 날 정희 씨는 미영에게 전화를 걸었습니다."],
    ["며칠 뒤 미영이 과일과 반찬을 들고 찾아왔습니다."],
    ["며칠 뒤 정희 씨는 다시 은행을 찾았습니다."],
    ["그런데 바로 그날 저녁 미영에게 전화가 왔습니다."],
    ["그리고 다음 송금일이 왔습니다."],
    ["얼마 뒤 미영이 집에 들렀습니다."],
    ["며칠 뒤 정희 씨는 정형외과 정기검진을 받고 나오는 길이었습니다."],
    ["며칠 뒤 서연이가 할머니에게 사진 한 장을 보냈습니다."],
    ["정희 씨는 곧바로 아들에게 전화했습니다."],
    ["그날 저녁 미영이 정희 씨 집으로 찾아왔습니다."],
    ["박성호는 준호와 함께 일했던 사람이었습니다."],
    ["정희 씨가 미영을 바라봤습니다."],
    ["미영이 가져온 서류를 식탁 위에 펼쳤습니다."],
    ["미영도 지금 빚이 정확히 얼마인지 모른다는 것이었습니다."],
    ["그날 밤 정희 씨는 집 안을 뒤지기 시작했습니다."],
    ["다음 날 정희 씨는 준호에게 전화했습니다."],
    ["그리고 정희 씨는 등기사항증명서를 식탁 위에 올려놓았습니다."],
    ["한참 뒤 아주 작은 목소리로 말했습니다."],
    ["그때 현관문이 열렸습니다."],
    ["다음 날 아침 세 사람은 함께 집을 나섰습니다."],
    ["정희 씨가 먼저 입을 열었습니다."],
    ["며칠 뒤 준호는 박성호를 찾아갔습니다."],
    ["집으로 돌아온 준호는 예전에 어머니 집을 담보로 얼마를 받을 수 있는지 알아봤던 등기사항증명서를 꺼냈습니다."],
    ["어느 날 정희 씨는 다시 은행에 갔습니다."]
  ];
  return splitNarrationByStoryAnchors(script, anchors);
}

function genericSemanticNarrationSegments(script, targetCount) {
  const paragraphs = String(script || "").replace(/\r\n/g, "\n").split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  const sentences = [];
  for (const paragraph of paragraphs) {
    const parts = paragraph.match(/[^.!?。！？]+[.!?。！？]?["'’”)]*/g);
    if (parts?.length) sentences.push(...parts.map((x) => x.trim()).filter(Boolean));
    else sentences.push(paragraph);
  }
  if (!sentences.length || targetCount < 1) return [];

  const boundary = /^(그날|그날 밤|그날 저녁|다음 날|다음날|며칠 뒤|얼마 뒤|몇 달 뒤|그 후|잠시 후|잠시후|그때|그러자|그런데|하지만|그리고|한편|집으로|은행을|병원을|시장에|현관문|아침이|저녁이)/;
  const scenes = [];
  let current = [];
  for (const sentence of sentences) {
    if (current.length && boundary.test(sentence)) {
      scenes.push(current.join(" ").trim());
      current = [];
    }
    current.push(sentence);
  }
  if (current.length) scenes.push(current.join(" ").trim());

  // Split the longest scene at sentence boundaries until we have enough semantic slots.
  while (scenes.length < targetCount) {
    let best = -1, bestParts = null;
    for (let i = 0; i < scenes.length; i++) {
      const parts = scenes[i].match(/[^.!?。！？]+[.!?。！？]?["'’”)]*/g)?.map((x) => x.trim()).filter(Boolean) || [];
      if (parts.length >= 2 && (!bestParts || parts.length > bestParts.length)) { best = i; bestParts = parts; }
    }
    if (best < 0) break;
    const mid = Math.max(1, Math.floor(bestParts.length / 2));
    scenes.splice(best, 1, bestParts.slice(0, mid).join(" "), bestParts.slice(mid).join(" "));
  }

  // If scene transitions are more numerous than visual slots, merge the shortest adjacent pair.
  while (scenes.length > targetCount) {
    let best = 0, bestLen = Infinity;
    for (let i = 0; i < scenes.length - 1; i++) {
      const len = scenes[i].length + scenes[i + 1].length;
      if (len < bestLen) { bestLen = len; best = i; }
    }
    scenes.splice(best, 2, `${scenes[best]} ${scenes[best + 1]}`.trim());
  }
  return scenes;
}

function splitFullNarrationAcrossParents(state, { force = false } = {}) {
  if (!state || state.storyboardMode !== "variable_beats") return false;
  const script = String(state.scriptText || "").replace(/\r\n/g, "\n").trim();
  const parents = Array.isArray(state.parents) ? state.parents : [];
  if (!script || !parents.length) return false;

  const alreadyComplete = parents.every((p) => String(p?.narration || "").trim());
  const isSeniorPilot30 = parents.length === 30 && script.includes("일흔한 살 이정희 씨는 매달 같은 날이면 은행에 갔습니다.") && script.includes("자기 자신이었습니다.");
  const needsSemanticUpgrade = isSeniorPilot30 && state.scriptAutoDistributionMode !== "semantic_story_anchor_v1";
  if (alreadyComplete && !force && !needsSemanticUpgrade) return false;

  // Current senior-longform pilot: use image/story meaning boundaries, not equal text length.
  // This is intentionally detected from the full script so it also repairs the existing
  // project without requiring the user to paste 30 segments manually.
  if (parents.length === 30 && script.includes("일흔한 살 이정희 씨는 매달 같은 날이면 은행에 갔습니다.") && script.includes("자기 자신이었습니다.")) {
    const semantic = seniorPilot30Segments(script);
    if (semantic?.length === 30 && semantic.every(Boolean)) {
      parents.forEach((parent, i) => { parent.narration = semantic[i]; });
      state.scriptAutoDistributedAt = Date.now();
      state.scriptAutoDistributedCount = parents.length;
      state.scriptAutoDistributedSourceLength = script.length;
      state.scriptAutoDistributionMode = "semantic_story_anchor_v1";
      return true;
    }
  }

  const semantic = genericSemanticNarrationSegments(script, parents.length);
  if (semantic.length !== parents.length || semantic.some((x) => !x)) return false;
  parents.forEach((parent, i) => { parent.narration = semantic[i]; });
  state.scriptAutoDistributedAt = Date.now();
  state.scriptAutoDistributedCount = parents.length;
  state.scriptAutoDistributedSourceLength = script.length;
  state.scriptAutoDistributionMode = "semantic_scene_v2";
  return true;
}

export function autoDistributeSimpleNarration(ep, { force = false } = {}) {
  ensureSimpleProductionV2(ep);
  const changed = splitFullNarrationAcrossParents(ep.simpleProductionV2, { force });
  if (changed) syncSimpleWorkspaceToCuts(ep, { skipNarrationAutoDistribution: true });
  return changed;
}

export function syncSimpleWorkspaceToCuts(ep, options = {}) {
  ensureSimpleProductionV2(ep); const state = ep.simpleProductionV2;
  if (!options.skipNarrationAutoDistribution) splitFullNarrationAcrossParents(state); const previous = new Map((ep.cuts || []).filter((cut) => cut?.simpleSourceId).map((cut) => [cut.simpleSourceId, cut])); const sources = [];
  state.parents.forEach((parent) => {
    if (state.contentFormat === "longform" && state.storyboardMode !== "variable_beats") {
      const children = parent.children.length ? parent.children : [normalizeChild({}, parent.index, 1)];
      children.forEach((child) => sources.push({
        id: `c${child.id}`,
        label: `${parent.label || `MASTER ${parent.index}`} · ${child.id}`,
        narration: child.narration || parent.narration,
        prompt: child.prompt || parent.prompt,
        imageAssetId: child.imageAssetId || parent.imageAssetId || null,
        videoAssetId: child.videoAssetId || parent.videoAssetId || null,
        videoMeta: child.videoMeta || parent.videoMeta || null,
        mediaType: child.videoAssetId && child.mediaType !== "image" ? "video" : "image",
        parentIndex: parent.index,
        childId: child.id,
      }));
    } else {
      sources.push({ id: `p${parent.index}`, label: parent.label || `MASTER ${parent.index}`, narration: parent.narration, prompt: parent.prompt, imageAssetId: parent.imageAssetId, videoAssetId: parent.videoAssetId || null, videoMeta: parent.videoMeta || null, mediaType: parent.videoAssetId ? "video" : "image", visualRole: parent.visualRole || null, parentIndex: parent.index, childId: null });
    }
  });
  ep.cuts = sources.map((source, i) => {
    const cut = previous.get(source.id) || (ep.cuts || [])[i] || newCut(i); cut.simpleSourceId = source.id; cut.simpleParentIndex = source.parentIndex; cut.simpleChildId = source.childId;
    cut.purpose = source.childId ? "세부" : (source.parentIndex === 1 ? "HOOK" : source.parentIndex === state.parents.length ? "엔딩" : "전개"); cut.situation = source.label; cut.visualRole = source.visualRole || null; cut.narration = source.narration || ""; cut.productionPrompt = source.prompt || "";
    cut.image = cut.image || { assetId: null, status: "미생성", generator: "", qcNote: "", retryReason: "" }; cut.image.assetId = source.imageAssetId || null; cut.image.status = source.imageAssetId ? "확정" : "미생성"; cut.image.generator = source.imageAssetId ? (cut.image.generator || "수동") : "";
    cut.video = cut.video || { assetId: null, duration: null, trimStart: 0, trimEnd: null, mute: true };
    if (source.videoAssetId) {
      const duration = Number(source.videoMeta?.duration);
      cut.video.assetId = source.videoAssetId;
      cut.video.duration = Number.isFinite(duration) ? duration : (cut.video.duration ?? null);
      cut.video.trimStart = 0;
      cut.video.trimEnd = Number.isFinite(duration) ? duration : (cut.video.trimEnd ?? null);
      cut.video.mute = true;
      cut.mediaType = source.mediaType === "video" ? "video" : "image";
    } else if (state.sourceFirst && (cut.sourceVideo?.sourceAssetId || cut.sourceVideo?.blobPath)) {
      cut.mediaType = "source_video";
    } else if (!cut.video?.assetId) {
      cut.video = { assetId: null, duration: null, trimStart: 0, trimEnd: null, mute: true };
      cut.mediaType = "image";
    } else if (cut.mediaType !== "video") {
      cut.mediaType = "image";
    }
    cut.motion = cut.motion || { type: "STATIC", startScale: 1, endScale: 1, panX: 0, panY: 0, easing: "linear" };
    if (state.storyboardMode === "variable_beats" && Number.isFinite(Number(source.parentIndex))) {
      const parent=state.parents[source.parentIndex-1];
      if (Number.isFinite(Number(parent?.finalDuration))) { cut.duration=cut.duration||{}; cut.duration.manual=Number(parent.finalDuration); }
      if (parent?.motionPreset && parent.motionPreset!=="STATIC") {
        if (parent.motionPreset==="ENDING_FOUR_STAGE") {
          cut.motion.type="AUTO_BEATS";
          cut.motion.visualBeats=[
            {label:"전체",start:0,duration:7,startScale:1,endScale:1.03,startPanX:0,endPanX:0,startPanY:0,endPanY:0,easing:"ease-in-out"},
            {label:"A",start:7,duration:6,startScale:1.18,endScale:1.22,startPanX:0.12,endPanX:0.12,startPanY:0,endPanY:0,easing:"ease-in-out"},
            {label:"B",start:13,duration:6,startScale:1.18,endScale:1.22,startPanX:-0.12,endPanX:-0.12,startPanY:0,endPanY:0,easing:"ease-in-out"},
            {label:"전체",start:19,duration:9.23,startScale:1.03,endScale:1,startPanX:0,endPanX:0,startPanY:0,endPanY:0,easing:"ease-in-out"}
          ];
        } else cut.motion.type=parent.motionPreset;
      }
      const ft=state.flowTrim?.[source.parentIndex];
      if (ft && cut.video?.assetId) { cut.video.trimStart=Number(ft.start)||0; cut.video.trimEnd=Number(ft.end)||cut.video.trimEnd; }
      cut.transition=(state.transitionLock?.connectiveBeats||[]).includes(source.parentIndex)?"DISSOLVE":"HARD_CUT";
      cut.productionSpec={visualRole:parent?.visualRole||null,motionPreset:parent?.motionPreset||"STATIC",positionLock:state.positionLock||null,finalPassVersion:state.finalPassVersion||null};
    } else cut.transition = cut.transition || "HARD_CUT";
    return cut;
  });
  // Image reuse is Episode data (parent.reuseImageFrom = source beat number), never a rule
  // derived from the beat count.
  if (state.storyboardMode==="variable_beats") {
    state.parents.forEach((parent)=>{
      const from=Number(parent?.reuseImageFrom); if(!Number.isFinite(from)||from<1) return;
      const dst=ep.cuts[parent.index-1],src=ep.cuts[from-1];
      if(dst&&src?.image?.assetId&&!dst.image?.assetId){dst.image={...dst.image,assetId:src.image.assetId,status:"확정",generator:src.image.generator||"재사용"};}
    });
  }
  reindexCuts(ep.cuts); return ep;
}

const SENIOR_NATURAL_DIRECTION_V1 = [
  ["SOFT_PUSH",["전체","정희"],"잔액/마지막 생활비 의미에서만 접근"],
  ["REFRAME",["전체","딸기"],"딸기를 내려놓는 감정에서 정지"],
  ["STATIC",["전체"],"집의 적막함 유지"],
  ["SOFT_PUSH",["전체","정희·서연"],"두 사람 관계에만 천천히 접근"],
  ["HOLD_AFTER_PUSH",["서연","정희"],"폭로 직전 약한 접근 후 정지"],
  ["REFRAME",["정희","거래내역"],"밤의 확인 행동을 따라 느리게 이동"],
  ["SOFT_PUSH",["전체","정희"],"전화 대화 감정에만 미세 접근"],
  ["SOFT_PUSH",["두 사람","대화"],"전체 구도 중심, 대화 심화 때만 접근"],
  ["MULTI_REFRAME",["전체","정희","거래내역·손","정희"],"긴 장면; 한 방향 장시간 줌 금지"],
  ["HOLD_AFTER_PUSH",["정희"],"통화 의미가 바뀌는 순간 정지"],
  ["STATIC",["전체"],"송금 중단의 허전함을 정적으로 유지"],
  ["REFRAME",["전체","영수증"],"증거가 드러날 때만 구도 전환"],
  ["SOFT_PUSH",["전체","미영·성호"],"몰래 지켜보는 거리감 유지"],
  ["STATIC",["사진"],"짧은 증거 장면; 효과 불필요"],
  ["HOLD_AFTER_PUSH",["정희"],"준호의 반응에서는 화면 유지"],
  ["MULTI_REFRAME",["두 사람","통장·서류","두 사람"],"비밀 공개 순서를 따라 전환"],
  ["STATIC",["전체"],"회상 장면의 무게 유지"],
  ["SOFT_PAN",["서류·상황"],"빚의 흐름을 아주 느리게 따라감"],
  ["MULTI_REFRAME",["전체","서류","미영"],"정보 공개 순서에 맞춤"],
  ["STATIC",["인물"],"불안을 움직임으로 과장하지 않음"],
  ["REFRAME",["공간","정희·서류"],"찾는 행동에서 한 번만 전환"],
  ["MULTI_REFRAME",["전체","정희","준호","두 사람"],"화자 변화에 맞춘 비규칙 전환"],
  ["REFRAME",["등기서류","준호"],"추궁 순간은 정지"],
  ["HOLD_AFTER_PUSH",["준호"],"엄마밖에 없어 직전 접근 후 정지"],
  ["MULTI_REFRAME",["전체","미영","준호","정희","세 사람"],"핵심 충돌; 화자에 맞춰 전환"],
  ["REFRAME",["테이블 전체","채무서류"],"차분한 정리 장면"],
  ["HOLD_AFTER_PUSH",["정희"],"오천만원은 못 줘 대사 자체는 정지"],
  ["MULTI_REFRAME",["준호·성호","준호","두 사람"],"사과 흐름에 맞춤"],
  ["MULTI_REFRAME",["서류","가족 전체","정희"],"6개월 변화의 초점을 순차 이동"],
  ["MULTI_REFRAME",["정희 전체","딸기","정희·서연","정희"],"원래 좋아했어 이후 움직임 축소"]
];

function applySeniorNaturalDirectionV1(ep) {
  const cuts = Array.isArray(ep?.cuts) ? ep.cuts : [];
  const state = ep?.simpleProductionV2;
  if (cuts.length !== 30 || !state || state.scriptAutoDistributionMode !== "semantic_story_anchor_v1") return false;
  cuts.forEach((cut, i) => {
    const [type, focuses, note] = SENIOR_NATURAL_DIRECTION_V1[i];
    cut.motion = cut.motion || {};
    cut.motion.type = type === "STATIC" ? "STATIC" : "NATURAL_DIRECTION";
    cut.motion.directionProfile = "SENIOR_NATURAL_V1";
    cut.motion.directionMode = type;
    cut.motion.focusSequence = focuses;
    cut.motion.directorNote = note;
    // Preserve the user's hand-adjusted narration timing. Motion timing is expressed
    // proportionally so it adapts to the actual CUT duration instead of a fixed loop.
    const n = focuses.length;
    cut.motion.visualBeats = focuses.map((label, j) => ({
      label,
      startRatio: n === 1 ? 0 : j / n,
      durationRatio: n === 1 ? 1 : 1 / n,
      behavior: type === "STATIC" ? "HOLD" : (type === "HOLD_AFTER_PUSH" && j === n - 1 ? "HOLD" : type)
    }));
    const dissolveCuts = new Set([3, 11, 17, 26, 29]);
    const transition = dissolveCuts.has(i + 1) ? "DISSOLVE" : "HARD_CUT";
    cut.transition = transition;
    cut.transitionDuration = transition === "DISSOLVE" ? 0.35 : 0;
    cut.productionSpec = {...(cut.productionSpec || {}), naturalDirectionVersion:"SENIOR_NATURAL_V1", directionMode:type, directorNote:note};
  });
  state.naturalDirectionVersion = "SENIOR_NATURAL_V1";
  state.naturalDirectionAppliedAt = Date.now();
  state.updatedAt = Date.now();
  return true;
}

function semanticFocusesForCut(cut) {
  const text = [cut?.situation, cut?.narration, cut?.productionPrompt].filter(Boolean).join(" ");
  const focuses = ["전체"];
  const add = (label, re) => { if (re.test(text) && !focuses.includes(label)) focuses.push(label); };
  add("인물", /말했|바라|웃|울|표정|얼굴|어머니|아버지|엄마|아빠|아들|딸|며느리|사위|손녀|손자|남편|아내/);
  add("손·소품", /통장|서류|사진|휴대폰|전화|봉투|돈|영수증|계약|열쇠|반찬|음식|시장|병원|약|가방/);
  add("공간", /집|방|거실|주방|은행|시장|병원|식당|회사|현관|거리|차|아파트/);
  return focuses.slice(0, 4);
}

function applySeniorNaturalDirectionGeneric(ep) {
  const cuts = Array.isArray(ep?.cuts) ? ep.cuts : [];
  const state = ep?.simpleProductionV2;
  if (!state || state.contentFormat !== "longform" || cuts.length < 6) return false;
  cuts.forEach((cut, i) => {
    const text = [cut?.purpose, cut?.situation, cut?.narration, cut?.productionPrompt].filter(Boolean).join(" ");
    const focuses = semanticFocusesForCut(cut);
    const duration = Math.max(0, Number(cut?.duration?.manual ?? cut?.duration?.measured ?? cut?.duration?.estimated) || 0);
    const reveal = /비밀|사실|그런데|하지만|알게|발견|드러|꺼냈|보여|말했습니다|고백|반전|충격/.test(text);
    const quiet = /조용|침묵|가만|혼자|적막|기다|생각|바라봤|눈물|마지막|엔딩/.test(text);
    const evidence = /통장|서류|사진|영수증|계약|돈|문자|메시지|기록|등기/.test(text);
    let type = "SOFT_PUSH";
    if (cut?.mediaType === "video") type = "STATIC";
    else if (quiet && duration > 0 && duration < 35) type = "STATIC";
    else if (reveal) type = "HOLD_AFTER_PUSH";
    else if (evidence) type = focuses.length >= 3 ? "MULTI_REFRAME" : "REFRAME";
    else if (duration >= 55 || focuses.length >= 3) type = "MULTI_REFRAME";
    else if (i % 5 === 3) type = "SOFT_PAN";
    else if (i % 3 === 1) type = "REFRAME";

    cut.motion = cut.motion || {};
    cut.motion.type = type === "STATIC" ? "STATIC" : "NATURAL_DIRECTION";
    cut.motion.directionProfile = "SENIOR_NATURAL_V2";
    cut.motion.directionMode = type;
    cut.motion.focusSequence = focuses;
    cut.motion.directorNote = "장면의 인물·소품·공간 의미에 따라 자동 배치. 긴 단일 줌 반복 금지.";
    const n = focuses.length;
    cut.motion.visualBeats = focuses.map((label, j) => ({
      label,
      startRatio: n === 1 ? 0 : j / n,
      durationRatio: n === 1 ? 1 : 1 / n,
      behavior: type === "STATIC" ? "HOLD" : (type === "HOLD_AFTER_PUSH" && j === n - 1 ? "HOLD" : type)
    }));

    const emotionalBoundary = reveal || /다음 날|며칠 뒤|그날 밤|얼마 뒤|몇 달 뒤|시간이 흘/.test(text);
    const transition = i > 0 && emotionalBoundary && i % 2 === 0 ? "DISSOLVE" : "HARD_CUT";
    cut.transition = transition;
    cut.transitionDuration = transition === "DISSOLVE" ? 0.35 : 0;
    cut.productionSpec = {...(cut.productionSpec || {}), naturalDirectionVersion:"SENIOR_NATURAL_V2", directionMode:type, directorNote:cut.motion.directorNote};
  });
  state.naturalDirectionVersion = "SENIOR_NATURAL_V2";
  state.naturalDirectionAppliedAt = Date.now();
  state.updatedAt = Date.now();
  return true;
}

export function applyNaturalDirection(ep) {
  ensureSimpleProductionV2(ep);
  if (applySeniorNaturalDirectionGeneric(ep)) return ep;
  return applySimpleEffects(ep);
}

export function applySimpleEffects(ep) {
  const pattern = ["PUSH_IN_SLOW", "STATIC", "PAN_LEFT", "PUSH_IN_SLOW", "PAN_RIGHT", "ZOOM_OUT"];
  (ep.cuts || []).forEach((cut, index) => { const type = cut.mediaType === "video" ? "STATIC" : pattern[index % pattern.length]; cut.motion = cut.motion || {}; cut.motion.type = type;
    if (type === "PUSH_IN_SLOW") Object.assign(cut.motion, { startScale: 1, endScale: 1.06, panX: 0, panY: 0, easing: "ease-in-out" }); else if (type === "ZOOM_OUT") Object.assign(cut.motion, { startScale: 1.06, endScale: 1, panX: 0, panY: 0, easing: "ease-in-out" }); else if (type === "PAN_LEFT") Object.assign(cut.motion, { startScale: 1.05, endScale: 1.05, panX: -0.035, panY: 0, easing: "linear" }); else if (type === "PAN_RIGHT") Object.assign(cut.motion, { startScale: 1.05, endScale: 1.05, panX: 0.035, panY: 0, easing: "linear" }); else Object.assign(cut.motion, { startScale: 1, endScale: 1, panX: 0, panY: 0, easing: "linear" });
    if (index > 0 && index % 4 === 0) { cut.transition = "DISSOLVE"; cut.transitionDuration = 0.25; } else { cut.transition = "HARD_CUT"; cut.transitionDuration = 0; }
  }); return ep;
}

export function routeKeyToSimpleStep(routeKey) {
  const map = { simple: "story", plan: "story", story: "story", cutImages: "story", simpleAudio: "audio", cutAudio: "audio", simpleTimeline: "timeline", timeline: "timeline", simplePreview: "preview", preview: "preview", simpleExport: "export", cutExport: "export", export: "export" }; return map[routeKey] || "story";
}
export function simpleStepRoute(epId, stepKey) { const step = SIMPLE_V2_STEPS.find((item) => item.key === stepKey) || SIMPLE_V2_STEPS[0]; return `#/episode/${epId}/${step.route}`; }

// Applies an AI-produced editorial analysis (trim points + per-beat label/
// narration) to a SOURCE-FIRST episode. Generic for any registered source
// video - nothing here is specific to one collected clip, and it never
// hardcodes captions/timestamps the way older source-editorial presets did
// (see resolveSourceEditorialPlan in renderManifest.js). Input shape:
//   { beats: [{ label, narration, trimStart, trimEnd }, ...] }
// index/duration are always derived from trimStart/trimEnd order, never
// trusted from the input, so a caller can't desync them.
export function applySourceAnalysisResult(ep, parsed, { preserveOrder = false } = {}) {
  ensureSimpleProductionV2(ep);
  const state = ep.simpleProductionV2;
  if (!state.sourceFirst) throw new Error("SOURCE-FIRST 에피소드가 아닙니다.");
  const rawBeats = Array.isArray(parsed?.beats) ? parsed.beats : [];
  const rawEffects = Array.isArray(parsed?.effectCaptions) ? parsed.effectCaptions : [];
  if (!rawBeats.length) throw new Error("beats 배열이 비어 있습니다.");

  const sourceMedia = state.sourceMedia || ep.sourceFirstPlan?.sourceMedia || {};
  const clipDuration = Number(sourceMedia.duration) > 0 ? Number(sourceMedia.duration) : Infinity;

  const normalized = rawBeats
    .map((b) => ({
      label: String(b?.label || "").trim(),
      narration: String(b?.narration || "").trim(),
      trimStart: Math.max(0, Number(b?.trimStart)),
      trimEnd: Math.min(Number(b?.trimEnd), clipDuration),
    }))
    .filter((b) => Number.isFinite(b.trimStart) && Number.isFinite(b.trimEnd) && b.trimEnd > b.trimStart)
    // Legacy/manual import sorts by source time. A planned order (preserveOrder) is kept as given
    // so plans may reorder, repeat or reveal the ending first.
    .sort((a, b) => (preserveOrder ? 0 : a.trimStart - b.trimStart))
    .map((b, i) => ({ index: i + 1, label: b.label || `Beat ${i + 1}`, narration: b.narration, trimStart: b.trimStart, trimEnd: b.trimEnd, duration: b.trimEnd - b.trimStart }));

  if (!normalized.length) throw new Error("유효한 beat가 없습니다 (trimStart/trimEnd 확인).");

  ep.sourceFirstPlan = {
    ...(ep.sourceFirstPlan || {}),
    version: 3,
    analysisStatus: "ready",
    analyzedAt: Date.now(),
    // "source": effectCaptions are source-video seconds and are converted to output time by the
    // Render Manifest Compiler. Anything else (legacy) is already output time.
    effectCaptionsTimeDomain: parsed?.timeDomain === "source" ? "source" : "output",
    sourceAssetId: state.sourceAssetId || ep.sourceFirstPlan?.sourceAssetId || null,
    sourceMedia: { ...sourceMedia },
    beats: normalized,
    effectCaptions: rawEffects.map((e) => ({
      text: String(e?.text || "").trim(), start: Math.max(0, Number(e?.start)), end: Math.max(0, Number(e?.end)),
      xPct: Number.isFinite(Number(e?.xPct)) ? Number(e.xPct) : 50, yPct: Number.isFinite(Number(e?.yPct)) ? Number(e.yPct) : 58,
      fontSizePct: Number.isFinite(Number(e?.fontSizePct)) ? Number(e.fontSizePct) : 8.2,
      color: String(e?.color || "#ffffff"), strokeColor: String(e?.strokeColor || "#111111"),
      animation: e?.animation === "none" ? "none" : "pop", rotateDeg: Number(e?.rotateDeg || 0),
    })).filter((e) => e.text && Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > e.start),
  };

  state.storyboardCount = normalized.length;
  state.parents = normalized.map((beat) => ({
    id: String(beat.index), index: beat.index, label: beat.label, narration: beat.narration, prompt: "",
    imageAssetId: null, imageMeta: null, videoAssetId: null, videoMeta: { sourceMedia: { ...sourceMedia } },
    visualRole: "SOURCE_VIDEO", children: [], finalDuration: beat.duration, motionPreset: "STATIC",
  }));
  state.sourceTrimPlan = normalized.map((beat) => ({ beat: beat.index, start: beat.trimStart, end: beat.trimEnd }));

  syncSimpleWorkspaceToCuts(ep, { skipNarrationAutoDistribution: true });

  // syncSimpleWorkspaceToCuts only preserves an existing cut's sourceVideo; it
  // does not know each beat's own trim window, so that part is set here -
  // same pattern app.js already uses for the single whole-clip beat this
  // episode started with, just one trim range per beat instead of one shared range.
  (ep.cuts || []).forEach((cut, i) => {
    const beat = normalized[i];
    if (!beat) return;
    cut.mediaType = "source_video";
    cut.sourceVideo = {
      sourceAssetId: sourceMedia.sourceAssetId || null,
      url: sourceMedia.playbackUrl || sourceMedia.blobUrl || "",
      blobPath: sourceMedia.blobPath || "",
      playbackValidUntil: Number(sourceMedia.playbackValidUntil || 0) || null,
      originalUrl: sourceMedia.originalUrl || "",
      ...(sourceMedia.sha256 ? { sha256: String(sourceMedia.sha256) } : {}),
      trimStart: beat.trimStart, trimEnd: beat.trimEnd, mute: false,
    };
    cut.duration = cut.duration || {};
    cut.duration.manual = beat.duration;
  });

  invalidateTimelineReview(ep);
  invalidatePreviewReview(ep);

  return { beatCount: normalized.length, totalTrimmedSeconds: normalized.reduce((sum, b) => sum + b.duration, 0) };
}

