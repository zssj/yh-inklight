/**
 * [INPUT]: 依赖 Obsidian ItemView、AnnotationStore 数据与插件主类回调
 * [OUTPUT]: 对外提供 AnnotationSidebarView，将当前文件或全库 annotation 合并为可筛选、可跳转、可导出的总览卡片，卡片可挂标签；
 *           标签编辑按内容推荐历史标签，卡片底部折叠展示字面相关的其他批注（受 contentRelations 设置控制）；
 *           相关行可「确认关联」：把一个共享标签写入两侧批注（行内选择条挑标签，可见可改可取消），
 *           已确认的关联显示为「已关联 xx」chip，点 chip 从两侧断开——确认结果落在 tags 字段上，是 MOC 的共享标签；
 *           标签筛选激活时导出按钮转为导出该标签的 MOC 页（vault 根 MOC/ 文件夹，无则新建，非墨光生成的同名页拒绝覆盖）
 * [POS]: views 模块的右侧 Leaf 总览面板，承载搜索、颜色/类型/标签筛选、排序、跳转、删除、导出模板、字面关联与确认关联；
 *        顶部搜索/范围/筛选/排序/导出统一收进单一折叠菜单（默认收起，展开态记在视图字段上），列表区域常驻不被菜单挤压；
 *        **卡片上的编辑一律在浮动面板里完成（views/editPanel）**：标签编辑与「想法」编辑都开到
 *        document.body 上的浮动外壳，列表 DOM 一个节点都不动——卡片高度不变，所以开编辑器不会让
 *        下面的卡片位移，整表重绘也删不掉输入框。历史上把输入框塞进卡片文档流，才需要
 *        编辑期挡重绘 / 压住延迟绘制 / 键盘避让滚动这一整套守卫，且仍会「一闪而过」；
 *        视图不可见时（切走标签页/侧栏折叠）不重建，置 pendingVisibleRender 等重新可见再补
 *        ——隐藏元素量不到滚动位置，此时的清空重建会把用户正在读的位置丢成顶部；
 *        全库列表按需渲染：首屏 60 张，之后由列表底部哨兵的 IntersectionObserver 驱动，
 *        用户滚到附近才追加下一批（不再定时把全库铺完），listToken 作废旧批次；
 *        渲染前已预热关联快照时，卡片相关区直接同步取命中，不再逐卡 await prepare；
 *        render/refreshList 各有一次「无变化就跳过」的守卫（store.version + 筛选 + 活动文件），
 *        避免切走再切回时把上千张卡整表重建；
 *        重建后按「视角身份 + 锚点卡」恢复滚动位置：同一批筛选下数据变化（新增/删除批注）
 *        不再把用户从列表深处弹回顶部，换范围/换筛选则照旧回到顶部
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { ItemView, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";

import type OverlayAnnotationsPlugin from "../../main";
import { dismissFloatingPanel, openNoteEditorPanel, openTagEditorPanel } from "./editPanel";
import {
  ANNOTATION_COLORS,
  AnnotationColor,
  AnnotationExportFormat,
  AnnotationRelation,
  AnnotationSortMode,
  COLOR_LABELS,
  CommentAnnotation,
  EpubCommentAnnotation,
  EpubHighlightAnnotation,
  FileAnnotationDocument,
  HighlightAnnotation,
  PdfCommentAnnotation,
  PdfHighlightAnnotation,
} from "../storage/types";
import { AnnotationKind, AnnotationMode, buildCards, canExtractAtomCard, SidebarCard } from "./cardModel";
import { CardBodyHost, renderCardBody } from "./cardBody";
import { renderRelatedBlock } from "./relatedBlock";
import {
  applyScrollRestore,
  pickScrollAnchor,
  placeScrollRestore,
  RESTORE_MAX_CARDS,
  restorePending,
  ScrollRestore,
  ScrollRestoreTarget,
} from "./scrollRestore";
import { openAnnotationTarget } from "./navigation";
import { hasTag, tagKey } from "../storage/tags";
import type { TagRef } from "../storage/annotationStore";

export const ANNOTATION_SIDEBAR_VIEW = "yh-inklight-sidebar";

/** 首屏同步渲染的卡片数：切全库时先把一屏铺出来，剩余按需追加 */
const INITIAL_CARD_BATCH = 24;
/** 后续每批追加的卡片数：单批越小，主线程被占用的时间越短 */
const CARD_BATCH_SIZE = 40;
/** 空闲回调的兜底等待：即使一直不空闲，也要在 120ms 内继续追加 */
const CARD_BATCH_TIMEOUT_MS = 120;
/**
 * 哨兵提前量：列表底部还有这么多像素时就开始追加下一批。
 * 只比一屏略大，保证滚动时不露白；远远不够时会一直追加，等于回到「全库铺满」。
 */
const SENTINEL_MARGIN_PX = 600;
/** 正文 Markdown 的预渲染范围：卡片进入列表可视区前这么多像素就解析，滚动时不露白 */
const CONTENT_PRERENDER_MARGIN_PX = 400;
/** 路径/时间排序共用的校对器：localeCompare 每次调用都会重建默认实例，排序时开销可观 */
const PATH_COLLATOR = new Intl.Collator();

type AnnotationScope = "current" | "all";
type TypeFilter = "all" | AnnotationKind;

export class AnnotationSidebarView extends ItemView {
  private annotationScope: AnnotationScope = "current";
  private query = "";
  private color: AnnotationColor | "all" = "all";
  private type: TypeFilter = "all";
  private sort: AnnotationSortMode = "document";
  /** 标签筛选的比较键；空字符串表示不筛选 */
  private tagFilter = "";
  private exportFormat: AnnotationExportFormat = "summary";
  /**
   * 顶部折叠菜单的展开态；必须存在视图字段上，重绘后仍保持用户上一次的选择。
   * 展开/收起以 panel.hidden 为唯一硬状态（见 applyMenuVisibility），class 只用于样式。
   */
  private menuOpen = false;
  /** 菜单面板与触发按钮的直连引用：render 时登记，点击时直接操作，不再靠 querySelector 二次查找 */
  private menuPanel: HTMLElement | null = null;
  private menuButton: HTMLElement | null = null;
  private renderToken = 0;
  /** 列表追加代次：新一次 render / refreshList 会作废上一轮未跑完的分批任务 */
  private listToken = 0;
  /** 列表底部哨兵的观察器：滚到附近才继续追加卡片，离开面板时不白白铺 DOM */
  private listObserver: IntersectionObserver | null = null;
  /**
   * 正文 Markdown 的延迟渲染队列：key 是卡片里的 .yh-ov-content 元素，
   * 进入列表可视区才调用 paint。随列表重建一起清空（元素已不在 DOM，不能留着观察）。
   */
  private pendingContent = new Map<Element, () => void>();
  private contentObserver: IntersectionObserver | null = null;
  /** 首屏那批卡片正常立即渲染（避免闪一下原始 Markdown），之后追加的才延迟 */
  private deferMarkdown = false;
  private renderTimer: number | null = null;
  /**
   * 上一次成功渲染的内容指纹。内容没变（同一批批注、同一组筛选、同一个活动文件）时
   * requestRender 直接返回：从主界面切回侧栏、或 file-open 触发的刷新都不再重建整表。
   */
  private renderedKey = "";
  /**
   * 上一次渲染时的「视角身份」（范围 + 搜索 + 筛选 + 排序 + 当前文件），不含数据版本。
   * 数据变化触发的重建要保留滚动位置，视角变化则是用户主动换内容，回到顶部。
   */
  private renderedIdentity = "";
  /**
   * 深列表补落位：恢复时补卡预算（RESTORE_MAX_CARDS）用尽、内容还不够高，
   * 第一次像素落位会被 scrollHeight 夹住——记下 restore，等后续追加批次把
   * 内容补够后按锚点补落位一次（见 restorePending / placeScrollRestore）。
   * 每次列表重建都会被 renderCardList 重置。
   */
  private pendingRestore: ScrollRestore | null = null;
  /** requestRender(true) 用：刷新按钮与显式重载要绕开指纹守卫 */
  private forceRender = false;
  /**
   * 全库拍平结果缓存：store.version 变化（任何写入）即失效。
   * 避免每次重绘都 getIndexedDocuments + 对每个文档 buildCards 一遍。
   */
  private scopeCache: {
    version: number;
    scope: AnnotationScope;
    activePath: string;
    documents: FileAnnotationDocument[];
    cards: SidebarCard[];
  } | null = null;
  /** 字面关联的按需内存快照：随 store.version 自动失效，不落盘 */
  /**
   * 视图不可见（主区域标签页切走 / 侧栏折叠）时被挡下的重绘。
   * 隐藏元素量不到滚动位置（scrollTop 恒 0、卡片 rect 全零），此时重建等于把用户
   * 正在读的位置丢成顶部；等重新可见（layout-change）再补一次。
   */
  private pendingVisibleRender = false;
  /** 相关区 details 的展开态记在视图字段上：确认关联触发的重绘不会把用户刚展开的相关区折回去 */
  private readonly openRelated = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: OverlayAnnotationsPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return ANNOTATION_SIDEBAR_VIEW;
  }

  getDisplayText(): string {
    return "墨光批注";
  }

  getIcon(): string {
    return "yh-inklight-icon";
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("yh-sidebar");
    // 重新打开时容器可能已被清空：指纹必须作废，否则守卫会跳过一次真正需要的渲染
    this.renderedKey = "";
    this.renderedIdentity = "";
    // 点击委托挂在视图根节点上：header 每次重绘都会重建按钮，
    // 绑在按钮自身上的监听会随节点一起消失，委托则始终有效。
    this.registerDomEvent(this.containerEl, "click", (event) => this.handleViewClick(event));
    // 后台被挡下的重绘：切回前台再补，此时才量得到真实滚动位置。
    // layout-change 覆盖标签页切换/侧栏展开，active-leaf-change 兜住部分移动端切回路径。
    const flushVisible = (): void => {
      if (!this.pendingVisibleRender || !this.isVisible()) {
        return;
      }
      this.pendingVisibleRender = false;
      void this.render();
    };
    this.registerEvent(this.app.workspace.on("layout-change", flushVisible));
    this.registerEvent(this.app.workspace.on("active-leaf-change", flushVisible));
    await this.render();
  }

  async onClose(): Promise<void> {
    this.listToken += 1;
    this.listObserver?.disconnect();
    this.listObserver = null;
    this.resetDeferredContent();
    this.renderedKey = "";
    this.renderedIdentity = "";
    this.scopeCache = null;
    this.menuPanel = null;
    this.menuButton = null;
    // 浮动编辑面板不在这棵 DOM 里，视图关闭要主动收掉，否则会留在 body 上
    dismissFloatingPanel();
    this.pendingVisibleRender = false;
    this.openRelated.clear();
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
  }

  /**
   * 请求重绘。force = true 用于刷新按钮等「必须重建」的场景；
   * 默认走指纹守卫：内容没变就不动 DOM，切走再切回不会有任何重建成本。
   */
  requestRender(force = false): void {
    if (force) {
      this.forceRender = true;
    }
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
    }
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      void this.render();
    }, 0);
  }

  /**
   * 视角身份：只含用户选的那几个维度，不含数据版本。
   * 数据版本变化（新增/删除批注）要刷新列表，但用户滚到哪就该留在哪；
   * 视角变了才是换了另一批内容，回到顶部才符合预期。
   */
  private listIdentity(): string {
    const activePath = this.annotationScope === "current" ? (this.plugin.annotationScopeFile()?.path ?? "") : "";
    return [this.annotationScope, this.query, this.color, this.type, this.sort, this.tagFilter, activePath].join("\u0001");
  }

  /**
   * 内容指纹：只有它变化时才值得重建整张侧栏。
   * 有意不含 openRelated（那是卡片内部 details 的展开态，重绘时由卡片自己带出）。
   */
  private currentKey(): string {
    return [this.listIdentity(), this.plugin.store.version, this.plugin.settings.contentRelations ? 1 : 0].join("\u0002");
  }

  /**
   * 视图此刻是否真的可见。取不到 Obsidian 的 isShown（测试环境）时按可见处理，
   * 宁可多绘一次，也不要因为判不出来把列表冻在旧数据上。
   */
  private isVisible(): boolean {
    const el = this.containerEl as HTMLElement & { isShown?: () => boolean };
    return typeof el.isShown === "function" ? el.isShown() : true;
  }

  /**
   * 重建前记下滚动位置：像素位置 + 列表顶端第一张可见卡片。
   * 必须在清空 DOM 之前调用，之后列表里已经没有卡片可量了。
   */
  private captureScroll(list?: HTMLElement | null): ScrollRestore | null {
    const target = list ?? this.containerEl.querySelector<HTMLElement>(".yh-ov-list");
    if (!target) {
      return null;
    }
    const top = target.scrollTop;
    if (top <= 1) {
      return null;
    }
    const listTop = target.getBoundingClientRect().top;
    const cards = Array.from(target.querySelectorAll<HTMLElement>(".yh-ov-card"), (card) => {
      const rect = card.getBoundingClientRect();
      return { id: card.dataset.id ?? "", top: rect.top, bottom: rect.bottom };
    });
    return { top, ...pickScrollAnchor(cards, listTop) };
  }

  /**
   * 当前范围下的文档与卡片。全库范围按 store.version 复用上一次拍平的结果：
   * 切走再切回、file-open 触发的刷新都不必重新读文档、重建全部卡片。
   */
  private async loadScope(
    force = false,
  ): Promise<{ documents: FileAnnotationDocument[]; cards: SidebarCard[] } | null> {
    // 「当前文件」的源文件走 plugin 解析：视图开在主区域时它自己就是活动 leaf，
    // workspace.getActiveFile() 会返回 null，必须回落到最近一次打开的文件。
    const file = this.plugin.annotationScopeFile();
    if (this.annotationScope === "current" && !file) {
      return null;
    }
    const activePath = this.annotationScope === "current" ? (file?.path ?? "") : "";
    const version = this.plugin.store.version;
    const cached = this.scopeCache;
    if (!force && cached && cached.version === version && cached.scope === this.annotationScope && cached.activePath === activePath) {
      return { documents: cached.documents, cards: cached.cards };
    }

    const documents =
      this.annotationScope === "all"
        ? await this.plugin.store.getIndexedDocuments()
        : [await this.plugin.store.getDocument(file!)];
    const cards = documents.flatMap((document) => buildCards(document));
    this.scopeCache = { version, scope: this.annotationScope, activePath, documents, cards };
    return { documents, cards };
  }

  async render(): Promise<void> {
    const token = ++this.renderToken;
    const listToken = ++this.listToken;
    const force = this.forceRender;
    this.forceRender = false;
    const key = this.currentKey();
    const identity = this.listIdentity();
    const container = this.containerEl.children[1] ?? this.containerEl;
    // 内容没变且列表还在：直接保留现有 DOM（含滚动位置），不重建
    if (!force && key === this.renderedKey && container.querySelector(".yh-ov-list")) {
      return;
    }
    // 视图在后台时不要重建：隐藏元素量不到滚动位置（scrollTop 恒 0），清空重建等于
    // 把用户正在读的位置丢成顶部。先记下请求，重新可见时由 layout-change 补一次；
    // 首次绘制（容器里还没有 .yh-ov-list）不走这条，免得一直空着。
    if (!this.isVisible() && container.querySelector(".yh-ov-list")) {
      this.pendingVisibleRender = true;
      return;
    }
    // 视角没变、只是数据变了 → 重建后回到原位；视角变了 → 从顶部开始
    const restore = this.renderedIdentity === identity ? this.captureScroll() : null;
    this.listObserver?.disconnect();
    this.listObserver = null;
    this.resetDeferredContent();

    container.empty();
    container.addClass("yh-overview");

    const file = this.plugin.annotationScopeFile();
    this.renderHeader(container);
    this.renderMenu(container, file);

    if (this.annotationScope === "current" && !file) {
      container.createDiv({ cls: "yh-empty", text: "Open a Markdown or PDF file to inspect annotations." });
      this.renderedKey = key;
      this.renderedIdentity = identity;
      return;
    }

    const scope = await this.loadScope(force);
    if (!scope || token !== this.renderToken) {
      return;
    }
    const { documents } = scope;
    if (this.plugin.settings.contentRelations) {
      await this.plugin.prepareRelations(documents);
      if (token !== this.renderToken) {
        return;
      }
    }
    const rawCards = scope.cards;
    const cards = this.filterCards(rawCards);
    this.renderCountLine(container, rawCards, documents.length);

    const list = container.createDiv({ cls: "yh-ov-list" });
    this.renderCardList(list, cards, listToken, restore);
    this.renderedKey = key;
    this.renderedIdentity = identity;
    this.pendingVisibleRender = false;
  }

  /**
   * 只刷新卡片列表（不重建搜索框等控件），用于搜索输入时保持焦点。
   */
  private async refreshList(): Promise<void> {
    const listToken = ++this.listToken;
    const root = this.containerEl.children[1] ?? this.containerEl;
    const list = root.querySelector<HTMLElement>(".yh-ov-list");
    if (!list) {
      await this.render();
      return;
    }
    const key = this.currentKey();
    if (key === this.renderedKey) {
      return;
    }
    const identity = this.listIdentity();
    // 位置必须在清空之前取：清空后列表里已经没有卡片可量
    const restore = this.renderedIdentity === identity ? this.captureScroll(list) : null;
    const scope = await this.loadScope();
    if (!scope) {
      await this.render();
      return;
    }
    const { documents, cards: rawCards } = scope;
    if (this.plugin.settings.contentRelations) {
      await this.plugin.prepareRelations(documents);
    }
    // 等待期间可能有更新的搜索/重绘：旧结果直接丢弃，避免覆盖新列表
    if (listToken !== this.listToken) {
      return;
    }
    const cards = this.filterCards(rawCards);

    this.listObserver?.disconnect();
    this.listObserver = null;
    this.resetDeferredContent();
    list.empty();
    this.renderCardList(list, cards, listToken, restore);

    const countEl = root.querySelector<HTMLElement>(".yh-ov-count");
    if (countEl) {
      const highlightCount = rawCards.filter((card) => card.kind === "highlight" && !card.orphaned).length;
      const noteCount = rawCards.filter((card) => card.note && !card.orphaned).length;
      const scopeLabel = this.annotationScope === "all" ? `${documents.length} files` : "current file";
      countEl.textContent = `${scopeLabel} · ${highlightCount} highlights · ${noteCount} notes`;
    }
    this.renderedKey = key;
    this.renderedIdentity = identity;
  }

  /**
   * 顶部计数行。重建时新建、就地更新时只改文字：口径只有这一处，
   * 别在 saveCardContent 那条路上另算一份，否则两处数出来的数会慢慢漂开。
   */
  private renderCountLine(container: Element, cards: SidebarCard[], documentCount: number): void {
    const highlightCount = cards.filter((card) => card.kind === "highlight" && !card.orphaned).length;
    const noteCount = cards.filter((card) => card.note && !card.orphaned).length;
    const scopeLabel = this.annotationScope === "all" ? `${documentCount} files` : "current file";
    const text = `${scopeLabel} · ${highlightCount} highlights · ${noteCount} notes`;
    const existing = container.querySelector<HTMLElement>(".yh-ov-count");
    if (existing) {
      existing.setText(text);
      return;
    }
    container.createDiv({ cls: "yh-ov-count", text });
  }

  /**
   * 列表按需渲染：先同步铺首屏，剩余卡片等哨兵滚到附近再追加。
   *
   * 早先的做法是「定时把所有批次铺完」，结果是切到全库后一秒内就把全库上千张卡
   * 全塞进 DOM——之后每次从主界面切回侧栏，浏览器都要为整棵树重做样式与布局，
   * 手机上还会因为节点过多被系统回收。改成按需追加后，DOM 规模跟着实际滚动深度走；
   * 内容、顺序与筛选结果不变，只是还没滚到的卡片尚未创建。
   */
  private renderCardList(
    list: Element,
    cards: SidebarCard[],
    token: number,
    restore: ScrollRestore | null = null,
  ): void {
    if (!cards.length) {
      list.createDiv({ cls: "yh-empty", text: "No matching annotations." });
      return;
    }
    // 新列表、新状态：上一轮未完成的深列表补落位不再适用
    this.pendingRestore = null;

    let cursor = 0;
    // 哨兵永远作为列表最后一个子节点：卡片插在它前面，滚到它就追加下一批
    const sentinel = list.createDiv({ cls: "yh-ov-sentinel" });

    const append = (size: number): boolean => {
      if (token !== this.listToken) {
        return true;
      }
      const end = Math.min(cursor + size, cards.length);
      for (; cursor < end; cursor += 1) {
        this.renderCardBefore(list, cards[cursor], sentinel);
      }
      return cursor >= cards.length;
    };

    // 首屏这批立即渲染正文（它们就在眼前）；之后的批次等滚到再解析 Markdown
    this.deferMarkdown = false;
    let finished = append(INITIAL_CARD_BATCH);
    if (restore) {
      // 恢复位置要补的批次都在首屏之外，正文照旧延迟到进入视口再解析，
      // 否则「滚到很深的位置时数据变了」会一次解析几百张卡，等于把卡顿搬回来
      this.deferMarkdown = true;
      finished = this.restoreListScroll(list as HTMLElement, append, finished, restore);
    }
    if (finished) {
      sentinel.remove();
      return;
    }
    this.deferMarkdown = true;

    const scheduleNext = (): void => {
      if (typeof IntersectionObserver === "undefined") {
        // 老 WebView 没有观察器：退回「空闲时段继续追加」，行为与本轮之前一致
        this.scheduleCardBatch(() => {
          if (!append(CARD_BATCH_SIZE)) {
            this.settlePendingRestore(list as HTMLElement);
            scheduleNext();
          } else {
            this.settlePendingRestore(list as HTMLElement);
            sentinel.remove();
          }
        });
        return;
      }
      if (this.listObserver) {
        return;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          if (token !== this.listToken) {
            observer.disconnect();
            if (this.listObserver === observer) {
              this.listObserver = null;
            }
            return;
          }
          if (!entries.some((entry) => entry.isIntersecting)) {
            return;
          }
          observer.disconnect();
          if (this.listObserver === observer) {
            this.listObserver = null;
          }
          if (append(CARD_BATCH_SIZE)) {
            this.settlePendingRestore(list as HTMLElement);
            sentinel.remove();
          } else {
            this.settlePendingRestore(list as HTMLElement);
            scheduleNext();
          }
        },
        // 观察器以列表自身为根：侧栏被折叠时哨兵不可见，不会继续铺 DOM
        { root: list as HTMLElement, rootMargin: `${SENTINEL_MARGIN_PX}px 0px` },
      );
      this.listObserver = observer;
      observer.observe(sentinel);
    };

    scheduleNext();
  }

  /**
   * 回到重建前的滚动位置。
   *
   * 列表是「滚到才建」的，重建后只有首屏那么高，直接写 scrollTop 会被夹住；
   * 所以先按需补渲染（最多 RESTORE_MAX_CARDS 张，再深就退回像素落位、其余交给滚动追加），
   * 落位按锚点卡对齐——像素坐标在重建前后不是同一坐标系（上方未绘制卡按估算高度报高），
   * 认卡不认像素才落得回同一处内容。
   *
   * 预算用尽时内容还容不下原位置：像素落位被当时的 scrollHeight 夹住（深列表近千卡时
   * 必现）。记进 pendingRestore，等后续追加批次把内容补够后按锚点补落位一次
   * （settlePendingRestore），全库滑到深处再回来也能落回原位。
   */
  private restoreListScroll(
    list: HTMLElement,
    append: (size: number) => boolean,
    finished: boolean,
    restore: ScrollRestore,
  ): boolean {
    const target = this.restoreTarget(list);
    const fill = (atLeastHeight: number): boolean => {
      let done = finished;
      let budget = RESTORE_MAX_CARDS;
      while (!done && budget > 0 && target.contentHeight() < atLeastHeight) {
        done = append(CARD_BATCH_SIZE);
        budget -= CARD_BATCH_SIZE;
      }
      return done;
    };
    const done = applyScrollRestore(target, restore, fill);
    // 全部卡都渲染完了就不会再有后续批次，别留下一个永远等不到落位的 pendingRestore
    this.pendingRestore = !done && restorePending(target, restore) ? restore : null;
    return done;
  }

  /** 恢复落位的量测/写入接口：真实布局值现量现用，估算高度不影响锚点落位 */
  private restoreTarget(list: HTMLElement): ScrollRestoreTarget {
    return {
      contentHeight: () => list.scrollHeight,
      viewportHeight: () => list.clientHeight,
      // 内容坐标系偏移（rect 差 + scrollTop）：上方卡片按估算高度报也不影响锚点落位
      anchorContentOffset: (anchorId: string): number | null => {
        for (const card of Array.from(list.querySelectorAll<HTMLElement>(".yh-ov-card"))) {
          if (card.dataset.id === anchorId) {
            return card.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
          }
        }
        return null;
      },
      setTop: (top: number) => {
        list.scrollTop = top;
      },
    };
  }

  /**
   * 追加批次后的深列表补落位：内容已够容下原位置时按锚点落位一次并清掉挂起状态。
   * 哨兵在内容补够前本来就在视口里，观察器会自动连续追加，不需要用户先滚一下。
   */
  private settlePendingRestore(list: HTMLElement): void {
    const restore = this.pendingRestore;
    if (!restore) {
      return;
    }
    const target = this.restoreTarget(list);
    if (!restorePending(target, restore)) {
      placeScrollRestore(target, restore);
      this.pendingRestore = null;
    }
  }

  /**
   * 正文 Markdown 的延迟渲染：卡片进入列表可视区（提前 400px）才解析。
   * 首屏那批不走这里——可见的卡如果先显示原始 Markdown 再换成正稿会闪一下。
   */
  private deferCardContent(element: HTMLElement, paint: () => void): void {
    if (typeof IntersectionObserver === "undefined") {
      paint();
      return;
    }
    if (!this.contentObserver) {
      const root = this.containerEl.querySelector<HTMLElement>(".yh-ov-list");
      this.contentObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) {
              continue;
            }
            this.contentObserver?.unobserve(entry.target);
            const job = this.pendingContent.get(entry.target);
            if (!job) {
              continue;
            }
            this.pendingContent.delete(entry.target);
            job();
          }
        },
        { root, rootMargin: `${CONTENT_PRERENDER_MARGIN_PX}px 0px` },
      );
    }
    this.pendingContent.set(element, paint);
    this.contentObserver.observe(element);
  }

  /** 列表重建前必须清空：被移除的节点不能再留在观察器与队列里，否则是 DOM 泄漏 */
  private resetDeferredContent(): void {
    this.contentObserver?.disconnect();
    this.contentObserver = null;
    this.pendingContent.clear();
  }

  private scheduleCardBatch(run: () => void): void {
    type IdleWindow = Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    };
    const idle = (window as IdleWindow).requestIdleCallback;
    if (idle) {
      idle(run, { timeout: CARD_BATCH_TIMEOUT_MS });
      return;
    }
    window.setTimeout(run, 16);
  }

  private renderHeader(container: Element): void {
    const header = container.createDiv({ cls: "yh-ov-head" });
    header.createSpan({ cls: "yh-ov-title", text: "Inklight" });
    const actions = header.createDiv({ cls: "yh-ov-head-actions" });

    // 搜索/范围/筛选/排序/导出的唯一入口：默认收起，点击展开；有生效筛选时点亮小圆点
    const menu = actions.createEl("button", {
      cls: "yh-icon-btn yh-ov-menu-btn",
      attr: {
        type: "button",
        title: "筛选与导出",
        "aria-label": "筛选与导出",
        "aria-expanded": String(this.menuOpen),
      },
    });
    setIcon(menu, "sliders-horizontal");
    this.menuButton = menu;
    this.applyMenuVisibility();

    const refresh = actions.createEl("button", {
      cls: "yh-icon-btn yh-ov-refresh",
      attr: { type: "button", title: "Refresh", "aria-label": "Refresh annotations" },
    });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => this.requestRender(true));

    const close = actions.createEl("button", {
      cls: "yh-icon-btn yh-ov-close",
      attr: { type: "button", title: "Close panel", "aria-label": "Close panel" },
    });
    setIcon(close, "x");
    close.addEventListener("click", () => {
      void this.leaf.detach();
    });
  }

  /** 视图级点击委托：目前只处理顶部菜单按钮，避免按钮被重绘重建后丢失监听 */
  private handleViewClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.closest(".yh-ov-menu-btn")) {
      return;
    }
    // 阻断冒泡：插件在 document 上还有批注点击处理，侧栏点击不应触发它
    event.preventDefault();
    event.stopPropagation();
    this.setMenuOpen(!this.menuOpen);
  }

  /**
   * 唯一的菜单开合入口：字段 + 面板 hidden + 按钮 aria/样式一次写齐。
   * hidden 是硬开关（CSS 用 [hidden] 兜底），不依赖 is-open 类是否被正确移除。
   */
  private setMenuOpen(open: boolean): void {
    this.menuOpen = open;
    this.applyMenuVisibility();
  }

  private applyMenuVisibility(): void {
    const panel = this.menuPanel;
    if (panel) {
      panel.toggleClass("is-open", this.menuOpen);
      panel.hidden = !this.menuOpen;
    }
    const button = this.menuButton;
    if (button) {
      button.toggleClass("is-open", this.menuOpen);
      button.setAttribute("aria-expanded", String(this.menuOpen));
      button.toggleClass("is-active", this.hasActiveFilters());
    }
  }

  /** 有任一筛选/搜索/范围生效时，菜单按钮点亮小圆点，收起态也能看出列表被过滤过 */
  private hasActiveFilters(): boolean {
    return (
      this.query.trim().length > 0 ||
      this.annotationScope !== "current" ||
      this.color !== "all" ||
      this.type !== "all" ||
      this.tagFilter !== ""
    );
  }

  /**
   * 顶部控件统一收进一个折叠菜单：默认收起，避免搜索 + 五个下拉 + 导出常驻把列表挤成窄条。
   * 展开态记在 this.menuOpen 上，任何一次重绘（改筛选、刷新）后保持展开；
   * 展开/收起只切菜单自身的 class，不重绘列表，因此列表内容与滚动位置都不受影响。
   */
  private renderMenu(container: Element, file: TFile | null): void {
    // 默认按收起态创建（带 hidden），再由 applyMenuVisibility 按 menuOpen 校正，避免首帧闪开
    const panel = container.createDiv({ cls: "yh-ov-menu", attr: { hidden: "hidden" } });
    this.menuPanel = panel;
    this.applyMenuVisibility();

    // 搜索批注
    const search = panel.createEl("input", {
      cls: "yh-ov-search",
      attr: { type: "search", placeholder: "搜索批注..." },
    });
    search.value = this.query;
    let searchTimer: number | null = null;
    search.addEventListener("input", () => {
      this.query = search.value;
      // 搜索只走 refreshList（不整表重建），徽标点手动同步，收起后仍能看出列表被过滤
      this.menuButton?.toggleClass("is-active", this.hasActiveFilters());
      if (searchTimer !== null) {
        window.clearTimeout(searchTimer);
      }
      searchTimer = window.setTimeout(() => {
        searchTimer = null;
        void this.refreshList();
      }, 200);
    });

    // 范围：当前文件 / 全库
    const scope = panel.createEl("select", { cls: "yh-filter-select", attr: { title: "批注范围" } });
    scope.createEl("option", { text: "当前文件", value: "current" });
    scope.createEl("option", { text: "全库", value: "all" });
    scope.value = this.annotationScope;
    scope.addEventListener("change", async () => {
      this.annotationScope = scope.value as AnnotationScope;
      await this.render();
    });

    const filterRow = panel.createDiv({ cls: "yh-ov-menu-row" });
    const color = filterRow.createEl("select", { cls: "yh-filter-select" });
    color.createEl("option", { text: "全部颜色", value: "all" });
    for (const item of ANNOTATION_COLORS) {
      color.createEl("option", { text: COLOR_LABELS[item], value: item });
    }
    color.value = this.color;
    color.addEventListener("change", async () => {
      this.color = color.value as AnnotationColor | "all";
      await this.render();
    });

    const type = filterRow.createEl("select", { cls: "yh-filter-select" });
    type.createEl("option", { text: "全部类型", value: "all" });
    type.createEl("option", { text: "高亮", value: "highlight" });
    type.createEl("option", { text: "笔记", value: "note" });
    type.value = this.type;
    type.addEventListener("change", async () => {
      this.type = type.value as TypeFilter;
      await this.render();
    });

    const sortRow = panel.createDiv({ cls: "yh-ov-menu-row" });
    const sort = sortRow.createEl("select", { cls: "yh-filter-select" });
    const sortOptions = { document: "文档顺序", newest: "最新优先", oldest: "最早优先" } as const;
    for (const item of ["document", "newest", "oldest"] as const) {
      sort.createEl("option", { text: sortOptions[item], value: item });
    }
    sort.value = this.sort;
    sort.addEventListener("change", async () => {
      this.sort = sort.value as AnnotationSortMode;
      await this.render();
    });

    // 标签筛选：选项来自内存索引，按文件数降序；选中后自动切全库，否则当前文件里常为空
    const tagRow = panel.createDiv({ cls: "yh-ov-menu-row" });
    const tagSelect = tagRow.createEl("select", {
      cls: "yh-filter-select yh-tag-filter",
      attr: { title: "按标签筛选" },
    });
    tagSelect.createEl("option", { text: "全部标签", value: "" });
    const dictionary = this.plugin.store.getTagDictionary();
    const currentKey = this.tagFilter;
    const visibleTags = dictionary.filter((item, index) => index < 20 || item.key === currentKey);
    for (const item of visibleTags) {
      tagSelect.createEl("option", { text: `${item.name} (${item.fileCount})`, value: item.key });
    }
    if (currentKey && !dictionary.some((item) => item.key === currentKey)) {
      tagSelect.createEl("option", { text: currentKey, value: currentKey });
    }
    tagSelect.value = currentKey;
    tagSelect.addEventListener("change", async () => {
      this.tagFilter = tagSelect.value;
      if (this.tagFilter) {
        this.annotationScope = "all";
      }
      await this.render();
    });

    const boardButton = tagRow.createEl("button", {
      cls: "yh-icon-btn yh-tag-board-btn",
      attr: { type: "button", title: "在标签总览中查看", "aria-label": "在标签总览中查看" },
    });
    setIcon(boardButton, "layout-grid");
    boardButton.addEventListener("click", () => {
      void this.plugin.activateTagBoard(this.tagFilter || undefined);
    });

    // 导出：按钮 + 格式，语义与原先底部导出栏一致，只是收进菜单
    // 标签筛选激活时按钮转为「导出该标签的 MOC 页」（vault 根 MOC/ 文件夹），未筛选时行为与原先一致
    panel.createDiv({ cls: "yh-ov-menu-sep" });
    const exportRow = panel.createDiv({ cls: "yh-ov-menu-row yh-ov-menu-export" });
    const tagFilterActive = this.tagFilter !== "";
    const tagFilterName = tagFilterActive
      ? (this.plugin.store.getTagDictionary().find((item) => item.key === this.tagFilter)?.name ?? this.tagFilter)
      : "";
    const exportButton = exportRow.createEl("button", {
      cls: "yh-export-btn",
      text: tagFilterActive ? `↑ 导出「${tagFilterName}」` : "↑ 导出批注",
      attr: { type: "button", title: tagFilterActive ? "导出当前筛选标签的 MOC 页（vault 根 MOC 文件夹）" : "导出批注" },
    });
    exportButton.disabled = tagFilterActive ? false : this.annotationScope === "current" && !file;
    exportButton.addEventListener("click", async () => {
      if (tagFilterActive) {
        const result = await this.plugin.store.exportTagMoc(this.tagFilter, this.exportFormat, this.plugin.settings.obTagBridge);
        if (result.status === "written") {
          new Notice(`已导出标签 MOC 至 ${result.file.path}`);
        } else if (result.status === "skipped-foreign") {
          new Notice(`已跳过：${result.path} 已存在且不是墨光生成的页面，请手动处理`);
        } else {
          new Notice("该标签下没有批注，无可导出");
        }
        return;
      }
      if (this.annotationScope === "current" && !file) {
        return;
      }
      const exported =
        this.annotationScope === "all"
          ? await this.plugin.store.exportAllNotes(this.exportFormat, this.plugin.settings.obTagBridge)
          : await this.plugin.store.exportNotes(file!, this.exportFormat, this.plugin.settings.obTagBridge);
      new Notice(`已导出笔记至 ${exported.path}`);
    });
    const exportFormat = exportRow.createEl("select", { cls: "yh-filter-select yh-export-format", attr: { title: "导出格式" } });
    exportFormat.createEl("option", { text: "默认摘要", value: "summary" });
    exportFormat.createEl("option", { text: "按颜色分组", value: "by-color" });
    exportFormat.createEl("option", { text: "只导出笔记", value: "notes-only" });
    exportFormat.createEl("option", { text: "阅读笔记", value: "reading-notes" });
    exportFormat.value = this.exportFormat;
    exportFormat.addEventListener("change", () => {
      this.exportFormat = exportFormat.value as AnnotationExportFormat;
    });
  }

  /** 把卡片插到哨兵之前：哨兵始终是列表最后一个节点，观察器才代表「已渲染的末尾」 */
  private renderCardBefore(list: Element, cardData: SidebarCard, before: Element | null): void {
    const node = this.buildCardElement(cardData);
    if (before && before.parentElement === list) {
      list.insertBefore(node, before);
      return;
    }
    list.appendChild(node);
  }

  private buildCardElement(cardData: SidebarCard): HTMLElement {
    const file = this.fileForCard(cardData);
    const card = document.createElement("div");
    for (const [name, value] of Object.entries(this.cardAttributes(cardData))) {
      card.setAttribute(name, value);
    }
    // 内容、字段顺序、动作行由 views/cardBody 唯一产出，与点击高亮的浮层是同一份 DOM
    renderCardBody(card, cardData, this.buildCardHost(cardData, file));

    if (this.plugin.settings.contentRelations) {
      // 与浮层同一份 DOM：命中/写入走插件单点，这里只给展开态
      renderRelatedBlock(
        card,
        cardData,
        this.plugin.createRelatedHost(
          cardData,
          {
            isOpen: (cardId) => this.openRelated.has(cardId),
            setOpen: (cardId, open) => {
              if (open) {
                this.openRelated.add(cardId);
              } else {
                this.openRelated.delete(cardId);
              }
            },
          },
          { prepared: true },
        ),
      );
    }

    // 卡片里不再有任何编辑控件：标签与想法都开在浮动面板里，
    // 所以卡片 DOM 是纯投影——整表重绘不会删掉用户正在输入的内容。
    return card;
  }

  /**
   * 把视图能力组装成卡片回调：渲染器只认这张表，列表与浮层各给各的。
   * 没给回调 = 该动作此刻不可用，不渲染按钮——绝不画「点了没反应」的控件。
   */
  private buildCardHost(cardData: SidebarCard, file: TFile | null): CardBodyHost {
    const exportRecord = this.plugin.store.getExportRecord(cardData.sourcePath);
    const exportedFile = exportRecord.notePath ? this.app.vault.getAbstractFileByPath(exportRecord.notePath) : null;

    return {
      host: "list",
      fileName: file?.name ?? cardData.sourcePath,
      app: this.app,
      component: this,
      tags: {
        // 标签编辑器开到 body 上的浮动面板里：卡片高度不变，列表不抖，重绘也删不掉它
        onStartTagEdit: (anchor, repaint) => {
          if (!file) {
            return;
          }
          const quickApply = this.quickApplyFor(file);
          openTagEditorPanel({
            anchor,
            tags: cardData.tags,
            suggestions: [...this.plugin.getRecommendedTags(cardData), ...this.plugin.getTagSuggestions()],
            // 只有用户点下拉里的 AI 行才会走到这里；默认复用缓存，force 时重新请求
            requestAi: (force) => this.plugin.suggestTagsForCard(cardData, force),
            ...(quickApply ? { quickApply } : {}),
            onChange: (next) => {
              cardData.tags = next;
              // 只重绘这一张卡的 chip 行：不动列表，就没有「点一下就整屏重排」
              repaint();
              void this.persistCardTags(file, cardData, next);
            },
            // 只有标签筛选生效时，改标签才会让这张卡从当前结果里进/出，需要重建列表；
            // 其余情况 chip 行已经就地更新过，不必为一次编辑把全库列表重排一遍
            onClose: () => {
              if (this.tagFilter) {
                this.requestRender();
              }
            },
          });
        },
        onChipClick: (tag) => this.focusTag(tagKey(tag)),
      },
      actions: {
        "open-export":
          exportedFile instanceof TFile
            ? () => void this.plugin.openFileInNewTab(exportedFile)
            : undefined,
        // 提炼成卡片：门槛统一由 canExtractAtomCard 判定（只要自己写了内容，不限类型），
        // 三端浮层共用同一函数，避免这里拦了、浮层又漏出空卡
        "atom-card":
          file && canExtractAtomCard(cardData)
            ? () => void this.plugin.createAtomCardFor(cardData)
            : undefined,
        "edit-note": file && cardData.note
          ? (anchor) => this.openNotePanel(anchor, file, cardData, cardData.content)
          : undefined,
        "add-note": file && !cardData.note
          ? (anchor) => this.openNotePanel(anchor, file, cardData, "")
          : undefined,
        jump: file
          ? () => this.jumpTo(file, cardData.startOffset, cardData.pageNumber, cardData.mode, cardData.cfiRange)
          : undefined,
        delete: file ? () => void this.deleteCardWithNotice(file, cardData) : undefined,
      },
      onJumpRelation: (relation) => void this.jumpToRelation(relation),
      onRemoveRelation: (relation) => void this.removeRelation(file, cardData, relation),
      ...(this.deferMarkdown
        ? { deferContent: (element: HTMLElement, paint: () => void) => this.deferCardContent(element, paint) }
        : {}),
    };
  }

  private async deleteCardWithNotice(file: TFile, cardData: SidebarCard): Promise<void> {
    await this.deleteCard(file, cardData);
    new Notice("批注已删除");
    await this.plugin.refreshAnnotations();
  }

  private async jumpToRelation(relation: AnnotationRelation): Promise<void> {
    const target = this.app.vault.getAbstractFileByPath(relation.targetPath);
    if (!(target instanceof TFile)) {
      new Notice("目标文件已不存在，可点 × 解除这条关系");
      return;
    }
    await this.jumpTo(
      target,
      relation.targetOffset ?? 0,
      relation.targetPage ?? null,
      relation.targetMode,
      relation.targetCfi,
    );
  }

  /** 解除关系时两侧一起断：只删一侧会在对方卡片上留下指向自己的孤儿行 */
  private async removeRelation(
    file: TFile | null,
    cardData: SidebarCard,
    relation: AnnotationRelation,
  ): Promise<void> {
    if (!file) {
      return;
    }
    try {
      await this.plugin.store.removeRelation(file, cardData.id, relation.targetPath, relation.targetId);
      const target = this.app.vault.getAbstractFileByPath(relation.targetPath);
      if (target instanceof TFile) {
        await this.plugin.store.removeRelation(target, relation.targetId, cardData.sourcePath, cardData.id);
      }
      this.plugin.invalidateRelations();
      new Notice("已解除关系");
      await this.plugin.refreshAnnotations();
    } catch (error) {
      console.warn("yh-inklight: 解除关系失败", error);
      new Notice("解除关系失败，请检查写入权限或同步状态");
    }
  }

  /** 「沿用本文档标签」候选：只有开了 OB 标签互通且当前文档确实有标签时才给 */
  private quickApplyFor(file: TFile | null): { label: string; tags: readonly string[] } | undefined {
    if (!file || !this.plugin.settings.obTagBridge) {
      return undefined;
    }
    const tags = this.plugin.getFileObsidianTags(file);
    return tags.length > 0 ? { label: `沿用本文档标签（${tags.length}）`, tags } : undefined;
  }

  /** 卡片的标签 refs：高亮与其笔记共享同一份标签数组，写入时两者都要覆盖 */
  private tagRefs(card: SidebarCard): TagRef[] {
    const refs: TagRef[] = [];
    if (card.highlight) {
      refs.push({ filePath: card.sourcePath, annotationId: card.highlight.id });
    }
    if (card.note) {
      refs.push({ filePath: card.sourcePath, annotationId: card.note.id });
    }
    return refs;
  }

  /** 写入标签：一张卡片可能是高亮 + 笔记，两者写同一份数组 */
  private async persistCardTags(file: TFile | null, cardData: SidebarCard, tags: string[]): Promise<void> {
    if (!file) {
      return;
    }

    const refs = this.tagRefs(cardData);
    if (refs.length === 0) {
      return;
    }

    try {
      await this.plugin.store.setTags(refs, tags);
      // 标签变了，「标签 → 词频」字典要跟着重建，不等 3 秒缓存 TTL
      this.plugin.invalidateRelations();
    } catch (error) {
      console.warn("yh-inklight: 保存标签失败", error);
      new Notice("标签保存失败，请检查写入权限或同步状态");
    }
  }

  /** 把侧栏切到「只看该标签」：跨文档，并同步更新筛选下拉 */
  focusTag(key: string): void {
    if (!key) {
      return;
    }
    this.tagFilter = key;
    this.annotationScope = "all";
    void this.render();
  }

  private cardAttributes(card: SidebarCard): Record<string, string> {
    const attrs: Record<string, string> = { "data-id": card.id, "data-source-path": card.sourcePath };
    if (card.highlight) {
      attrs["data-highlight-id"] = card.highlight.id;
    }
    if (card.note) {
      attrs["data-note-id"] = card.note.id;
    }
    return attrs;
  }

  /**
   * 想法编辑面板。与标签同一套浮动外壳：anchor 是被点的动作按钮，
   * 面板挂在 body 上，卡片高度不变——所以「点添加想法」不会让列表跳动，
   * 整表重绘也不会把写到一半的内容删掉。
   *
   * 保存失败必须 throw：面板据此保持打开并保留用户输入，Notice 由这里给。
   */
  private openNotePanel(
    anchor: HTMLElement,
    file: TFile,
    cardData: SidebarCard,
    initialValue: string,
  ): void {
    openNoteEditorPanel({
      anchor,
      value: initialValue,
      onSave: async (content) => {
        try {
          await this.saveCardContent(file, cardData, content);
        } catch (error) {
          console.warn("yh-inklight: 保存想法失败", error);
          new Notice("保存失败，请检查写入权限或同步状态");
          throw error;
        }
        // 只换这一张卡：不重建列表，滚动位置一个像素都不动。
        // 以前这里走 refreshAnnotations() → requestRender() 整表重建，恢复滚动位置时
        // 视口上方的卡按 contain-intrinsic-size 估算高度，锚点校正把列表甩到别处
        // ——就是用户说的「保存后进度条跳到别的地方」。
        await this.refreshCardInPlace(cardData);
        // 阅读区高亮 / 书架 / 标签总览照旧刷新；侧栏与 updateOptions 跳过，它们都会重排列表
        await this.plugin.refreshAnnotations({ lightweight: true });
      },
      onClose: () => this.requestRender(),
    });
  }

  /**
   * 就地换掉列表里的那一张卡（保存想法后用）。
   *
   * 返回 false = 没法就地更新（列表还没建、卡片被当前筛选筛掉、或不在已渲染的那一段），
   * 此时**不同步 renderedKey**，让随后的 requestRender 整表重建兜底。
   *
   * 「最新/最早优先」排序下，这张卡的新排名要等下一次整表重建才生效——刻意如此：
   * 保存一下就把它挪到列表另一头、还要连带重排滚动位置，比顺序晚一步更让人意外。
   */
  private async refreshCardInPlace(previous: SidebarCard): Promise<boolean> {
    const list = this.containerEl.querySelector<HTMLElement>(".yh-ov-list");
    if (!list) {
      return false;
    }
    // store.version 已变：这里会重算拍平结果并刷新 scopeCache，但不碰任何 DOM
    const scope = await this.loadScope();
    if (!scope) {
      return false;
    }
    const next = scope.cards.find((card) => card.id === previous.id);
    const target = Array.from(list.querySelectorAll<HTMLElement>(".yh-ov-card")).find(
      (card) => card.dataset.id === previous.id,
    );
    if (!next || !target) {
      return false;
    }
    if (this.plugin.settings.contentRelations) {
      // 卡片里的相关区取 prepared 快照，快照随 store.version 失效：不预热就会显示旧关系
      await this.plugin.prepareRelations(scope.documents);
    }
    target.replaceWith(this.buildCardElement(next));
    this.renderCountLine(this.containerEl.children[1] ?? this.containerEl, scope.cards, scope.documents.length);
    // 列表已与当前数据对齐：把指纹对上，面板关闭时的 requestRender 就不会白重建一次
    this.renderedKey = this.currentKey();
    return true;
  }
  private async saveCardContent(file: TFile, card: SidebarCard, content: string): Promise<void> {
    if (card.note && card.mode === "pdf") {
      await this.plugin.store.updatePdfComment(file, {
        ...(card.note as PdfCommentAnnotation),
        content,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (card.note && card.mode === "md") {
      await this.plugin.store.updateComment(file, {
        ...(card.note as CommentAnnotation),
        content,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (card.note && card.mode === "epub") {
      await this.plugin.store.updateEpubComment(file, {
        ...(card.note as EpubCommentAnnotation),
        note: content,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (card.highlight && card.mode === "pdf") {
      const now = new Date().toISOString();
      const highlight = card.highlight as PdfHighlightAnnotation;
      await this.plugin.store.addPdfComment(file, {
        id: crypto.randomUUID(),
        highlightId: highlight.id,
        anchor: highlight.anchor,
        content,
        color: highlight.color,
        position: { offsetX: 20, offsetY: 0 },
        collapsed: false,
        author: this.plugin.settings.defaultAuthor,
        createdAt: now,
        updatedAt: now,
        replies: [],
        resolved: false,
      });
      return;
    }

    if (card.highlight && card.mode === "md") {
      const now = new Date().toISOString();
      const highlight = card.highlight as HighlightAnnotation;
      await this.plugin.store.addComment(file, {
        id: crypto.randomUUID(),
        highlightId: highlight.id,
        anchor: highlight.anchor,
        content,
        color: highlight.color,
        position: { offsetX: 20, offsetY: 0 },
        collapsed: false,
        author: this.plugin.settings.defaultAuthor,
        createdAt: now,
        updatedAt: now,
        replies: [],
        resolved: false,
      });
      return;
    }

    if (card.highlight && card.mode === "epub") {
      const now = new Date().toISOString();
      const highlight = card.highlight as EpubHighlightAnnotation;
      await this.plugin.store.addEpubComment(file, {
        id: crypto.randomUUID(),
        type: "epub-comment",
        color: highlight.color,
        style: highlight.style,
        anchor: highlight.anchor,
        note: content,
        createdAt: now,
        collapsed: false,
        author: this.plugin.settings.defaultAuthor,
        updatedAt: now,
        replies: [],
        resolved: false,
      });
    }
  }

  private async deleteCard(file: TFile, card: SidebarCard): Promise<void> {
    if (card.highlight) {
      await this.plugin.store.removeAnnotation(file, card.highlight.id);
    }
    if (card.note) {
      await this.plugin.store.removeAnnotation(file, card.note.id);
    }
  }

  private fileForCard(card: SidebarCard): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(card.sourcePath);
    return file instanceof TFile ? file : null;
  }

  private filterCards(cards: SidebarCard[]): SidebarCard[] {
    const needle = this.query.toLowerCase();
    const filtered = cards
      .filter((card) => this.color === "all" || card.color === this.color)
      .filter((card) => {
        if (this.type === "all") {
          return true;
        }
        if (this.type === "highlight") {
          return card.kind === "highlight";
        }
        return Boolean(card.note);
      })
      .filter((card) => !this.tagFilter || hasTag(card.tags, this.tagFilter))
      // 没输关键词时不必为每张卡拼一条 haystack：全库上千张卡这里是纯浪费
      .filter((card) =>
        needle === ""
          ? true
          : `${card.sourcePath} ${card.text} ${card.content} ${card.tags.join(" ")}`.toLowerCase().includes(needle),
      );

    if (this.sort === "document") {
      // 共用同一个 Collator：String#localeCompare 每次调用都重建默认校对器，
      // 上千张卡排序是几万次比较，这一项能差出十几毫秒
      return filtered.sort(
        (a, b) =>
          PATH_COLLATOR.compare(a.sourcePath, b.sourcePath) ||
          (a.pageNumber ?? 0) - (b.pageNumber ?? 0) ||
          a.startOffset - b.startOffset,
      );
    }

    // 时间排序用装饰-排序：ISO 字符串按字符序比较与时间序一致，
    // 每张卡只取一次时间戳，比较里不再反复解析
    const keyed = filtered.map((card) => ({ card, key: this.cardUpdatedAt(card) }));
    keyed.sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? -1 : 1));
    if (this.sort === "newest") {
      keyed.reverse();
    }
    return keyed.map((item) => item.card);
  }

  private cardUpdatedAt(card: SidebarCard): string {
    return card.note?.updatedAt ?? card.createdAt;
  }

  private async jumpTo(
    file: TFile,
    offset: number,
    pageNumber: number | null,
    mode: AnnotationMode = "md",
    cfiRange?: string,
  ): Promise<void> {
    // 程序化「查看批注目标」不改「当前文件」范围视角：否则总览跳出去再回来，
    // lastActiveFile 已被污染成目标文件，列表内容整个换成它的批注、滚动位置丢失
    await this.plugin.openKeepingScope(() =>
      openAnnotationTarget(this.app, { file, offset, pageNumber, mode, cfiRange }, (target, cfi) =>
        // 必须是「打开书 + 定位」：navigateEpubToCfi 只在已打开的阅读器里定位，
        // 书没开时它只会重试到超时，用户看到的就是「点了完全没反应、也不报错」。
        this.plugin.openEpubAtCfi(target.path, cfi),
      ),
    );
  }
}

/** 在 sidecar 文档的 6 个批注数组里按 id 找标签载体；找不到说明该批注已被删除 */

