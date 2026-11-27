/**
 * [INPUT]: 被测 src/storage/annotationStore.ts + tests/helpers/fakeVault 的内存 Vault
 * [OUTPUT]: 覆盖 sidecar 写入读回、索引 v2/tagNames、写入失败保护、损坏数据不覆盖、孤儿清理、改名迁移、导出
 * [POS]: L2 存储契约测试——数据丢失高危区；这些路径在真机上只能靠「批注还在不在」事后发现
 */

import { beforeEach, describe, expect, it } from "vitest";

import { noticeLog } from "obsidian";

import {
  AnnotationStore,
  AnnotationStoreReadError,
  AnnotationStoreWriteError,
} from "../../src/storage/annotationStore";
import { FileAnnotationDocument, HighlightAnnotation, TextAnchor } from "../../src/storage/types";
import { FakeVault, createApp } from "../helpers/fakeVault";

const MD_PATH = "读书笔记/复利.md";
const PDF_PATH = "papers/成本.pdf";
const SIDECAR_DIR = ".obsidian-annotations";

function anchorOf(text: string, start = 0): TextAnchor {
  return { startOffset: start, endOffset: start + text.length, selectedText: text, prefix: "", suffix: "" };
}

function highlightOf(id: string, text: string, start = 0, tags?: string[]): HighlightAnnotation {
  return { id, color: "yellow", anchor: anchorOf(text, start), createdAt: "2026-01-01T00:00:00.000Z", ...(tags ? { tags } : {}) };
}

function emptyDocument(filePath = MD_PATH): FileAnnotationDocument {
  return {
    filePath,
    fileHash: "",
    lastModified: "2026-01-01T00:00:00.000Z",
    highlights: [],
    comments: [],
    pdfHighlights: [],
    pdfComments: [],
    epubHighlights: [],
    epubComments: [],
    bookmarks: [],
    canvasNodes: [],
  };
}

interface Harness {
  vault: FakeVault;
  store: AnnotationStore;
  file: ReturnType<FakeVault["fileAt"]>;
}

async function setup(options: Parameters<typeof createApp>[0] = {}): Promise<Harness> {
  const { app, vault } = createApp({ files: { [MD_PATH]: "在复利效应的作用下，长期投资会放大收益。" }, ...options });
  const store = new AnnotationStore(app);
  await store.initialize();
  return { vault, store, file: vault.fileAt(MD_PATH) };
}

describe("initialize / getDocument", () => {
  it("初始化时创建 .obsidian-annotations 目录", async () => {
    const { vault } = await setup();
    expect(vault.getAbstractFileByPath(SIDECAR_DIR)).not.toBeNull();
  });

  it("没有 sidecar 时返回空文档且不落盘（读操作不产生垃圾文件）", async () => {
    const { store, vault } = await setup();
    const document = await store.getDocument(vault.fileAt(MD_PATH));

    expect(document.filePath).toBe(MD_PATH);
    expect(document.highlights).toEqual([]);
    expect(document.comments).toEqual([]);
    expect(vault.listFiles().filter((path) => path.endsWith(".json"))).toEqual([]);
  });

  it("index.json 损坏时回退空索引而不是抛错（避免整库不可用）", async () => {
    const { app, vault } = createApp({
      files: { [MD_PATH]: "正文", [`${SIDECAR_DIR}/index.json`]: "{ 这不是 JSON" },
    });
    const store = new AnnotationStore(app);

    await expect(store.initialize()).resolves.toBeUndefined();
    expect(store.getTagDictionary()).toEqual([]);
    expect(vault.readText(`${SIDECAR_DIR}/index.json`)).toBe("{ 这不是 JSON");
  });

  it("sidecar 损坏时报错并保留原文件，绝不静默覆盖", async () => {
    const { app, vault } = createApp({ files: { [MD_PATH]: "正文" } });
    const store = new AnnotationStore(app);
    await store.initialize();
    const sidecar = store.toSidecarPath(MD_PATH);
    vault.writeText(sidecar, "{ 半截 JSON");

    await expect(store.getDocument(vault.fileAt(MD_PATH))).rejects.toBeInstanceOf(AnnotationStoreReadError);
    expect(vault.readText(sidecar)).toBe("{ 半截 JSON");
  });
});

describe("saveDocument / addHighlight", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setup();
  });

  it("高亮写入 sidecar，并把索引推进到 v2", async () => {
    const { store, vault, file } = harness;
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));

    const sidecar = vault.readJson<FileAnnotationDocument>(store.toSidecarPath(MD_PATH));
    expect(sidecar.filePath).toBe(MD_PATH);
    expect(sidecar.highlights).toHaveLength(1);
    expect(sidecar.highlights[0].anchor.selectedText).toBe("复利效应");

    const index = vault.readJson<any>(`${SIDECAR_DIR}/index.json`);
    expect(index.version).toBe(3);
    expect(index.files[MD_PATH].highlightCount).toBe(1);
    expect(index.files[MD_PATH].sidecarPath).toBe(store.toSidecarPath(MD_PATH));
  });

  it("新实例能从磁盘读回同样的批注（跨会话持久化）", async () => {
    const { store, vault, file } = harness;
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));

    const reopened = new AnnotationStore({ vault } as any);
    await reopened.initialize();
    const document = await reopened.getDocument(vault.fileAt(MD_PATH));

    expect(document.highlights).toHaveLength(1);
    expect(document.highlights[0].id).toBe("h1");
  });

  it("高亮按起始 offset 排序，与阅读顺序一致", async () => {
    const { store, file } = harness;
    await store.addHighlight(file, highlightOf("late", "长期投资", 12));
    await store.addHighlight(file, highlightOf("early", "在复利效应", 0));

    expect((await store.getDocument(file)).highlights.map((item) => item.id)).toEqual(["early", "late"]);
  });

  it("标签写入索引：tagNames 保留用户写法，files[].tags 用比较键并升序", async () => {
    const { store, vault, file } = harness;
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2, ["金融", "Foo", "bar"]));

    const index = vault.readJson<any>(`${SIDECAR_DIR}/index.json`);
    // 排序规则是 localeCompare，中文与拉丁的先后由运行环境 locale 决定，这里只断言「升序且去重」
    expect(index.files[MD_PATH].tags).toEqual(["bar", "foo", "金融"].sort((a, b) => a.localeCompare(b)));
    expect(index.tagNames).toMatchObject({ foo: "Foo", 金融: "金融" });

    const dictionary = store.getTagDictionary();
    expect(dictionary.map((entry) => entry.key).sort()).toEqual(["bar", "foo", "金融"]);
    expect(dictionary.find((entry) => entry.key === "foo")?.name).toBe("Foo");
  });

  it("清空标签后 sidecar 里 tags 字段被删除，与老数据完全一致", async () => {
    const { store, vault, file } = harness;
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2, ["金融"]));
    await store.setTags([{ filePath: MD_PATH, annotationId: "h1" }], []);

    const sidecar = vault.readJson<FileAnnotationDocument>(store.toSidecarPath(MD_PATH));
    expect(sidecar.highlights[0]).not.toHaveProperty("tags");
  });

  it("写入失败时抛 AnnotationStoreWriteError，不推进索引也不污染缓存", async () => {
    const { app, vault } = createApp({
      files: { [MD_PATH]: "正文内容足够长以便定位。" },
      failWrite: (path) => path.startsWith(SIDECAR_DIR) && path.endsWith(".json") && !path.endsWith("index.json"),
    });
    const store = new AnnotationStore(app);
    await store.initialize();
    const file = vault.fileAt(MD_PATH);
    noticeLog.length = 0;

    await expect(store.addHighlight(file, highlightOf("h1", "正文", 0))).rejects.toBeInstanceOf(AnnotationStoreWriteError);
    expect(noticeLog.some((message) => message.includes("未保存"))).toBe(true);
    expect(vault.has(`${SIDECAR_DIR}/index.json`)).toBe(false);
    // 缓存里只可能是写之前读到的空文档，绝不含这次未落盘的高亮
    expect(store.getCachedDocument(MD_PATH)?.highlights ?? []).toEqual([]);
  });

  it("清空一个不存在的文件的标签不抛错（refs 为空直接返回）", async () => {
    const { store } = harness;
    await expect(store.setTags([], ["金融"])).resolves.toBeUndefined();
  });
});

describe("孤儿批注管理", () => {
  it("源文件被删后能计数，且清理只动索引里已失效的条目", async () => {
    const { store, vault } = await setup();
    await store.addHighlight(vault.fileAt(MD_PATH), highlightOf("h1", "复利效应", 2));
    const sidecar = store.toSidecarPath(MD_PATH);

    vault.removeFile(MD_PATH);
    expect(store.countOrphanedDocuments()).toBe(1);

    const removed = await store.cleanupOrphanedDocuments();
    expect(removed).toBe(1);
    expect(vault.has(sidecar)).toBe(false);

    const index = vault.readJson<any>(`${SIDECAR_DIR}/index.json`);
    expect(index.files).toEqual({});
    expect(store.countOrphanedDocuments()).toBe(0);
  });

  it("源文件仍存在时一个都不清理", async () => {
    const { store, vault } = await setup();
    await store.addHighlight(vault.fileAt(MD_PATH), highlightOf("h1", "复利效应", 2));

    expect(store.countOrphanedDocuments()).toBe(0);
    await expect(store.cleanupOrphanedDocuments()).resolves.toBe(0);
    expect(vault.has(store.toSidecarPath(MD_PATH))).toBe(true);
  });

  it("标签字典与文件列表都过滤掉源文件已删除的条目", async () => {
    const { store, vault } = await setup();
    await store.addHighlight(vault.fileAt(MD_PATH), highlightOf("h1", "复利效应", 2, ["金融"]));
    vault.removeFile(MD_PATH);

    expect(store.getTagDictionary()).toEqual([]);
    expect(store.getFilesForTag("金融")).toEqual([]);
  });
});

describe("migrateFilePath", () => {
  it("改名后 sidecar 搬到新路径，旧文件与旧索引条目都被清掉", async () => {
    const { store, vault } = await setup();
    await store.addHighlight(vault.fileAt(MD_PATH), highlightOf("h1", "复利效应", 2));

    const newPath = "读书笔记/复利（改名）.md";
    vault.writeText(newPath, vault.readText(MD_PATH));
    vault.removeFile(MD_PATH);

    await store.migrateFilePath(MD_PATH, vault.fileAt(newPath));

    const index = vault.readJson<any>(`${SIDECAR_DIR}/index.json`);
    expect(Object.keys(index.files)).toEqual([newPath]);
    expect(index.files[newPath].highlightCount).toBe(1);
    expect(vault.has(store.toSidecarPath(MD_PATH))).toBe(false);

    const moved = vault.readJson<FileAnnotationDocument>(store.toSidecarPath(newPath));
    expect(moved.filePath).toBe(newPath);
    expect(moved.highlights).toHaveLength(1);
  });

  it("旧路径没有 sidecar 时什么都不做", async () => {
    const { store, vault } = await setup();
    await expect(store.migrateFilePath("不存在.md", vault.fileAt(MD_PATH))).resolves.toBeUndefined();
  });
});

describe("migrateFilePaths（批量改名 / 文件夹移动）", () => {
  const OTHER = "wiki1/另一篇.md";
  const INDEX = `${SIDECAR_DIR}/index.json`;

  async function setupTwo(): Promise<{ store: AnnotationStore; vault: FakeVault }> {
    const { store, vault } = await setup();
    vault.writeText(OTHER, "另一篇的内容。");
    await store.addHighlight(vault.fileAt(MD_PATH), highlightOf("h1", "复利效应", 2));
    await store.addHighlight(vault.fileAt(OTHER), highlightOf("h2", "另一篇", 0));
    return { store, vault };
  }

  it("整批迁移：sidecar 全部跟到新路径，索引只写一次", async () => {
    const { store, vault } = await setupTwo();
    const moves = [
      { oldPath: MD_PATH, newPath: "wiki2/复利.md" },
      { oldPath: OTHER, newPath: "wiki2/另一篇.md" },
    ];
    for (const move of moves) {
      vault.writeText(move.newPath, vault.readText(move.oldPath));
      vault.removeFile(move.oldPath);
    }
    const writesBefore = vault.writeLog.filter((path) => path === INDEX).length;

    await store.migrateFilePaths(moves);

    const writesAfter = vault.writeLog.filter((path) => path === INDEX).length;
    expect(writesAfter - writesBefore).toBe(1);

    const index = vault.readJson<any>(INDEX);
    expect(Object.keys(index.files).sort()).toEqual(["wiki2/另一篇.md", "wiki2/复利.md"]);
    expect(vault.has(store.toSidecarPath(MD_PATH))).toBe(false);
    expect(vault.has(store.toSidecarPath(OTHER))).toBe(false);
    expect(vault.readJson<FileAnnotationDocument>(store.toSidecarPath("wiki2/复利.md")).highlights).toHaveLength(1);
  });

  it("没有 sidecar 的文件跳过，不影响同批其他文件", async () => {
    const { store, vault } = await setup();
    await store.addHighlight(vault.fileAt(MD_PATH), highlightOf("h1", "复利效应", 2));
    vault.writeText("无批注.md", "没有加过批注");
    vault.writeText("新位置/复利.md", vault.readText(MD_PATH));
    vault.removeFile(MD_PATH);

    await store.migrateFilePaths([
      { oldPath: "无批注.md", newPath: "新位置/无批注.md" },
      { oldPath: MD_PATH, newPath: "新位置/复利.md" },
    ]);

    const index = vault.readJson<any>(INDEX);
    expect(Object.keys(index.files)).toEqual(["新位置/复利.md"]);
    expect(vault.readJson<FileAnnotationDocument>(store.toSidecarPath("新位置/复利.md")).highlights).toHaveLength(1);
  });

  it("空批量与同路径条目都不写盘", async () => {
    const { store, vault } = await setup();
    await store.addHighlight(vault.fileAt(MD_PATH), highlightOf("h1", "复利效应", 2));
    const writesBefore = vault.writeLog.length;

    await store.migrateFilePaths([]);
    await store.migrateFilePaths([{ oldPath: MD_PATH, newPath: MD_PATH }]);

    expect(vault.writeLog.length).toBe(writesBefore);
  });

  it("迁移保留索引反查指针（导出笔记 → 批注回跳不断链）", async () => {
    const { store, vault } = await setup();
    await store.addHighlight(vault.fileAt(MD_PATH), highlightOf("h1", "复利效应", 2));
    const priv = store as unknown as { index: { files: Record<string, Record<string, unknown>> } };
    priv.index.files[MD_PATH].derivedNotePath = "导出/复利-notes.md";

    vault.writeText("wiki2/复利.md", vault.readText(MD_PATH));
    vault.removeFile(MD_PATH);
    await store.migrateFilePaths([{ oldPath: MD_PATH, newPath: "wiki2/复利.md" }]);

    const index = vault.readJson<any>(INDEX);
    expect(index.files["wiki2/复利.md"].derivedNotePath).toBe("导出/复利-notes.md");
  });
});

describe("hash 校验与锚点自愈", () => {
  it("文件被外部改动后重新定位锚点并写回新哈希", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 1));
    // fileHash 由编辑器事件链路在首次修改后补写，这里直接构造「已有哈希」的状态
    const seeded = await store.getDocument(file);
    await store.saveDocument({ ...seeded, fileHash: await store.hashFile(file) });
    const sidecar = store.toSidecarPath(MD_PATH);
    const before = vault.readJson<FileAnnotationDocument>(sidecar).fileHash;

    // 模拟 Obsidian 未运行时被同步覆盖：内容变化 + mtime 明显晚于 sidecar
    vault.writeText(MD_PATH, "前置新增内容。\n在复利效应的作用下，长期投资会放大收益。");
    vault.setMtime(MD_PATH, Date.now() + 10_000);

    // 模拟插件重启：新实例冷读时才走 hash 校验（运行中的编辑由 vault 事件即时迁移）
    const reopened = new AnnotationStore({ vault } as any);
    await reopened.initialize();
    const document = await reopened.getDocument(vault.fileAt(MD_PATH));
    const after = vault.readJson<FileAnnotationDocument>(sidecar);

    expect(document.highlights[0].orphaned).toBe(false);
    // 「前置新增内容。\n」共 8 个字符，原 offset 1 的选区整体右移
    expect(document.highlights[0].anchor.startOffset).toBe(1 + 8);
    expect(after.fileHash).not.toBe(before);
    expect(after.fileHash).toBe(document.fileHash);
  });

  it("内容被整体替换且已无共同点时标记 orphaned，数据仍然保留", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 1));
    const seeded = await store.getDocument(file);
    await store.saveDocument({ ...seeded, fileHash: await store.hashFile(file) });

    vault.writeText(MD_PATH, "αβγδεζηθικλμνξοπρστυφχψω");
    vault.setMtime(MD_PATH, Date.now() + 10_000);

    const reopened = new AnnotationStore({ vault } as any);
    await reopened.initialize();
    const document = await reopened.getDocument(vault.fileAt(MD_PATH));

    expect(document.highlights).toHaveLength(1);
    expect(document.highlights[0].orphaned).toBe(true);
  });
});

describe("导出", () => {
  it("导出单篇笔记到源文件同级目录，重复导出覆盖同一文件", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));

    const exported = await store.exportNotes(file);
    expect(exported.path).toBe("读书笔记/复利-notes.md");

    const content = vault.readText("读书笔记/复利-notes.md");
    expect(content).toContain("复利效应");

    const again = await store.exportNotes(file, "by-color");
    expect(again.path).toBe("读书笔记/复利-notes-by-color.md");
    expect(vault.listFiles()).toContain("读书笔记/复利-notes.md");
    expect(vault.listFiles()).toContain("读书笔记/复利-notes-by-color.md");
  });

  it("没有批注时导出也给出明确的空结果说明", async () => {
    const { store, file } = await setup();
    await store.exportNotes(file);
    expect((await store.getDocument(file)).highlights).toHaveLength(0);
  });

  it("用户在导出笔记里手写的段落，重复导出后原样保留", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));
    await store.exportNotes(file);

    const path = "读书笔记/复利-notes.md";
    vault.writeText(path, `${vault.readText(path)}\n## 我的心得\n\n这段是我自己写的，导出不该动它。\n\n[[另一篇笔记]]\n`);

    await store.exportNotes(file);

    const merged = vault.readText(path);
    expect(merged).toContain("这段是我自己写的，导出不该动它。");
    expect(merged).toContain("[[另一篇笔记]]");
    expect(merged).toContain("复利效应");
  });

  it("同 id 块被 sidecar 内容覆盖，块外段落保持不动", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));
    await store.exportNotes(file);

    const path = "读书笔记/复利-notes.md";
    const tampered = vault.readText(path).replace("复利效应", "被人手改错的文本");
    vault.writeText(path, `${tampered}\n块外段落。\n`);

    await store.exportNotes(file);

    const merged = vault.readText(path);
    expect(merged).toContain("复利效应");
    expect(merged).not.toContain("被人手改错的文本");
    expect(merged).toContain("块外段落。");
  });

  it("新增批注追加到导出笔记末尾，不覆盖已有内容", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));
    await store.exportNotes(file);

    const path = "读书笔记/复利-notes.md";
    vault.writeText(path, `${vault.readText(path)}\n追加前的手写内容。\n`);

    await store.addHighlight(file, highlightOf("h2", "长期投资", 13));
    await store.exportNotes(file);

    const merged = vault.readText(path);
    expect(merged).toContain("追加前的手写内容。");
    expect(merged).toContain("长期投资");
  });

  it("升级前的老格式导出（无块标记）也能按 callout 块更新，且不丢手写段落", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));

    const path = "读书笔记/复利-notes.md";
    const legacy = [
      "# Notes for 读书笔记/复利.md",
      "",
      "## Highlights",
      "",
      "> [!inklight-md|yellow] 读书笔记/复利.md - 2026-01-01T00:00:00.000Z ^md-h1",
      "> 复利效应",
      "",
      "## Sticky Notes",
      "",
      "我手写在老文件里的段落。",
      "",
    ].join("\n");
    vault.writeText(path, legacy);

    await store.exportNotes(file);

    const merged = vault.readText(path);
    expect(merged).toContain("我手写在老文件里的段落。");
    expect(merged).toContain("复利效应");
    expect(merged).toContain("^md-h1");
  });

  it("MOC 页在互通关闭时也保护用户手写内容", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2, ["概念"]));
    await store.exportTagMoc("概念", "summary", false);

    const path = "MOC/概念.md";
    expect(vault.has(path)).toBe(true);
    vault.writeText(path, `${vault.readText(path)}\n## 我的补充\n\nMOC 页里手写的补充说明。\n`);

    await store.exportTagMoc("概念", "summary", false);

    const merged = vault.readText(path);
    expect(merged).toContain("MOC 页里手写的补充说明。");
    expect(merged).toContain("复利效应");
  });
});

describe("EPUB 回链", () => {
  const EPUB_PATH = "books/复利 破局.epub";
  const CFI = "epubcfi(/6/28!/4[BE6O0]/140,/1:0,/1:118)";

  async function setupEpub(tags?: string[]): Promise<Harness & { epub: ReturnType<FakeVault["fileAt"]> }> {
    const { app, vault } = createApp({ files: { [EPUB_PATH]: "" } });
    const store = new AnnotationStore(app);
    await store.initialize();
    const epub = vault.fileAt(EPUB_PATH);
    await store.addEpubHighlight(epub, {
      id: "h1",
      type: "epub-highlight",
      color: "yellow",
      style: "fill",
      anchor: { cfiRange: CFI, chapter: "第一章", selectedText: "复利效应" },
      createdAt: "2026-01-01T00:00:00.000Z",
      ...(tags ? { tags } : {}),
    });
    return { vault, store, file: epub, epub };
  }

  function backLinkOf(content: string): string {
    const matched = content.match(/\[Back to source\]\((obsidian:\/\/[^)]+)\)/);
    expect(matched, `导出内容里没有协议回链：\n${content}`).not.toBeNull();
    return matched![1];
  }

  it("单文件导出的回链是自带目标（源文件 + CFI）的协议链接，不再是 #^ 自引用锚点", async () => {
    const { store, vault, epub } = await setupEpub();
    await store.exportNotes(epub);

    const content = vault.readText("books/复利 破局-notes.md");
    expect(content).not.toContain("(#^epub-h1)");

    const url = new URL(backLinkOf(content));
    expect(url.protocol).toBe("obsidian:");
    expect(url.hostname).toBe("inklight");
    expect(url.searchParams.get("mode")).toBe("epub");
    expect(url.searchParams.get("file")).toBe(EPUB_PATH);
    expect(url.searchParams.get("cfi")).toBe(CFI);
  });

  it("标签 MOC 页的 EPUB 回链同样是协议链接（MOC 页不在导出页路径白名单内）", async () => {
    const { store, vault } = await setupEpub(["复利效应"]);
    const result = await store.exportTagMoc("复利效应");

    expect(result.status).toBe("written");
    const content = vault.readText("MOC/复利效应.md");
    expect(content).not.toContain("(#^epub-h1)");

    const url = new URL(backLinkOf(content));
    expect(url.searchParams.get("file")).toBe(EPUB_PATH);
    expect(url.searchParams.get("cfi")).toBe(CFI);
  });

  it("Markdown 回链带 offset 与原文片段，不再只到文件头", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));
    await store.exportNotes(file);

    const content = vault.readText("读书笔记/复利-notes.md");
    const url = new URL(backLinkOf(content));

    expect(url.hostname).toBe("inklight");
    expect(url.searchParams.get("mode")).toBe("md");
    expect(url.searchParams.get("file")).toBe(file.path);
    expect(url.searchParams.get("offset")).toBe("2");
    expect(url.searchParams.get("text")).toBe("复利效应");
    expect(content).not.toContain(`[[${file.path}|Back to source]]`);
  });

  it("PDF 回链带 page 参数，不再赌 [[#page=N]] 私有锚点", async () => {
    const { app, vault } = createApp({ files: { [PDF_PATH]: "" } });
    const store = new AnnotationStore(app);
    await store.initialize();
    const pdf = vault.fileAt(PDF_PATH);
    await store.addPdfHighlight(pdf, {
      id: "p1",
      color: "green",
      anchor: { pageNumber: 7, rects: [{ pageNumber: 7, left: 0.1, top: 0.2, width: 0.3, height: 0.02 }], selectedText: "边际成本" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.exportNotes(pdf);

    const content = vault.readText(PDF_PATH.replace(/\.pdf$/i, "-notes.md"));
    const url = new URL(backLinkOf(content));

    expect(url.searchParams.get("mode")).toBe("pdf");
    expect(url.searchParams.get("page")).toBe("7");
    expect(content).not.toContain("#page=7|Back to source");
  });

  it("导出块只写 noteType::，章节已在 callout 标题里，不再重复一行 chapter::", async () => {
    const { app, vault } = createApp({ files: { [EPUB_PATH]: "" } });
    const store = new AnnotationStore(app);
    await store.initialize();
    const epub = vault.fileAt(EPUB_PATH);
    await store.addEpubHighlight(epub, {
      id: "h1",
      type: "epub-highlight",
      color: "yellow",
      style: "fill",
      anchor: { cfiRange: CFI, chapter: "第三章 复利", selectedText: "复利效应" },
      noteType: "insight",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.exportNotes(epub);

    const content = vault.readText("books/复利 破局-notes.md");
    expect(content).toContain("noteType:: insight");
    expect(content).not.toContain("chapter::");
    // 章节信息仍然可见，只是在 callout 标题里
    expect(content).toContain("第三章 复利");
  });

  it("同文件的关系导出成块链接，跨文件回落成纯文本引用", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));
    await store.addHighlight(file, highlightOf("h2", "长期投资", 13));
    await store.addRelation(file, "h1", {
      targetPath: file.path,
      targetId: "h2",
      targetMode: "md",
      type: "supports",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    await store.addRelation(file, "h1", {
      targetPath: "另一本书.md",
      targetId: "x9",
      targetMode: "md",
      type: "refutes",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    await store.exportNotes(file);

    const content = vault.readText("读书笔记/复利-notes.md");
    expect(content).toContain("supports:: [[#^md-h2]]");
    expect(content).toContain('refutes:: "另一本书.md#x9"');
  });

  it("同一目标同一类型重复确认只留一条关系；断开后关系消失", async () => {    const { store, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));
    const relation = {
      targetPath: file.path,
      targetId: "h2",
      targetMode: "md" as const,
      type: "supports" as const,
      createdAt: "2026-02-01T00:00:00.000Z",
    };
    await store.addRelation(file, "h1", relation);
    await store.addRelation(file, "h1", relation);
    expect((await store.getDocument(file)).highlights[0].relations).toHaveLength(1);

    await store.removeRelation(file, "h1", file.path, "h2");
    expect((await store.getDocument(file)).highlights[0].relations).toBeUndefined();
  });

  it("导出后索引记下反查指针：落在哪篇笔记、哪些块", async () => {
    const { store, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));
    await store.exportNotes(file);

    const record = store.getExportRecord(file.path);
    expect(record.notePath).toBe("读书笔记/复利-notes.md");
    expect(record.blockIds).toEqual({ h1: "md-h1" });
    expect(record.exportedAt).toBeTruthy();
  });

  it("改批注不会冲掉反查指针，重新导出后块清单才更新", async () => {
    const { store, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));
    await store.exportNotes(file);
    await store.addHighlight(file, highlightOf("h2", "长期投资", 13));

    // 只加批注还没重导：指针保持上一次导出的状态，不能被保存动作清空
    expect(store.getExportRecord(file.path).blockIds).toEqual({ h1: "md-h1" });

    await store.exportNotes(file);
    expect(store.getExportRecord(file.path).blockIds).toEqual({ h1: "md-h1", h2: "md-h2" });
  });

  it("标签 MOC 导出累计记到 mocPaths，不覆盖单文件导出记录", async () => {
    const { store, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2, ["复利"]));
    await store.exportNotes(file);
    await store.exportTagMoc("复利");

    const record = store.getExportRecord(file.path);
    expect(record.notePath).toBe("读书笔记/复利-notes.md");
    expect(record.mocPaths).toEqual(["MOC/复利.md"]);
  });

  it("删掉批注后，孤儿块检查能报出导出笔记里残留的那一块", async () => {
    const { store, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));
    await store.addHighlight(file, highlightOf("h2", "长期投资", 13));
    await store.exportNotes(file);
    await store.removeAnnotation(file, "h2");

    const report = await store.findOrphanBlocks();
    expect(report).toEqual([{ notePath: "读书笔记/复利-notes.md", blockIds: ["md-h2"] }]);
  });

  it("跨文件关系在目标未导出时落成协议链接，锚点来自关系快照", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));
    await store.addRelation(file, "h1", {
      targetPath: "books/穷查理宝典.epub",
      targetId: "x9",
      targetMode: "epub",
      type: "supports",
      createdAt: "2026-02-01T00:00:00.000Z",
      targetCfi: "epubcfi(/6/12!/4/18,/1:0,/1:53)",
      targetQuote: "复利的敌人是中断",
    });
    await store.exportNotes(file);

    const content = vault.readText("读书笔记/复利-notes.md");
    const matched = content.match(/supports:: \[支持：穷查理宝典\]\((obsidian:\/\/[^)]+)\)/);
    expect(matched, content).not.toBeNull();

    const url = new URL(matched![1]);
    expect(url.searchParams.get("mode")).toBe("epub");
    expect(url.searchParams.get("file")).toBe("books/穷查理宝典.epub");
    expect(url.searchParams.get("cfi")).toBe("epubcfi(/6/12!/4/18,/1:0,/1:53)");
  });

  it("目标文件已导出时，跨文件关系指向那篇导出笔记的块（Graph 有边）", async () => {
    const { app, vault } = createApp({ files: { "notes/a.md": "", "notes/b.md": "" } });
    const store = new AnnotationStore(app);
    await store.initialize();
    const a = vault.fileAt("notes/a.md");
    const b = vault.fileAt("notes/b.md");

    await store.addHighlight(b, highlightOf("h2", "目标句", 0));
    await store.exportNotes(b);

    await store.addHighlight(a, highlightOf("h1", "来源句", 0));
    await store.addRelation(a, "h1", {
      targetPath: b.path,
      targetId: "h2",
      targetMode: "md",
      type: "supports",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    await store.exportNotes(a);

    expect(vault.readText("notes/a-notes.md")).toContain("supports:: [[notes/b-notes#^md-h2]]");
  });

  it("提炼原子卡：写到指定目录、带出处块链接，重复点不重复生成", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, { ...highlightOf("h1", "复利效应", 2), noteType: "insight" });
    await store.exportNotes(file);

    const input = {
      annotationId: "h1",
      mode: "md" as const,
      quote: "复利效应",
      content: "重读的成本，是复利公式里的分母。",
      noteType: "insight" as const,
      tags: ["复利"],
    };

    const first = await store.createAtomCard(file, input, "卡片");
    expect(first.status).toBe("created");
    if (first.status !== "created") {
      throw new Error("expected created");
    }

    const text = vault.readText(first.path);
    expect(text).toContain("inklightId: md-h1");
    expect(text).toContain("[[读书笔记/复利-notes#^md-h1]]");
    expect(text).toContain("重读的成本，是复利公式里的分母。");
    expect(text).toContain("noteType: insight");

    const again = await store.createAtomCard(file, input, "卡片");
    expect(again).toEqual({ status: "exists", path: first.path });
  });

  it("提炼原子卡：卡片改名后仍认回同一张，不重复生成", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, { ...highlightOf("h1", "复利效应", 2), noteType: "insight" });
    const input = {
      annotationId: "h1",
      mode: "md" as const,
      quote: "复利效应",
      content: "重读的成本，是复利公式里的分母。",
      noteType: "insight" as const,
      tags: [],
    };

    const first = await store.createAtomCard(file, input, "卡片");
    if (first.status !== "created") {
      throw new Error("expected created");
    }

    // 用户在 Obsidian 里给卡片改了名：索引里记的旧路径随之失效
    await vault.adapter.rename(first.path, "卡片/换个标题.md");

    const again = await store.createAtomCard(file, input, "卡片");
    expect(again).toEqual({ status: "exists", path: "卡片/换个标题.md" });
    // 只该有一张卡：改名不该长出双胞胎
    expect(vault.listFiles().filter((path) => path.startsWith("卡片/"))).toEqual(["卡片/换个标题.md"]);
  });

  it("提炼原子卡：索引丢失后靠 frontmatter 的 inklightId 认回卡片并修回指针", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, { ...highlightOf("h1", "复利效应", 2), noteType: "insight" });
    const input = {
      annotationId: "h1",
      mode: "md" as const,
      quote: "复利效应",
      content: "重读的成本，是复利公式里的分母。",
      noteType: "insight" as const,
      tags: [],
    };

    const first = await store.createAtomCard(file, input, "卡片");
    if (first.status !== "created") {
      throw new Error("expected created");
    }

    // 模拟索引被删掉后重建：指针全丢，卡片还在
    vault.removeFile(".obsidian-annotations/index.json");
    await store.initialize();
    expect(store.getAtomCard(file.path, "h1")).toBeNull();

    // 索引重建后继续在这本书上批注：文件条目回来了，但 atomCards 指针仍是空的
    await store.addHighlight(file, highlightOf("h2", "长期投资", 8));

    const again = await store.createAtomCard(file, input, "卡片");
    expect(again).toEqual({ status: "exists", path: first.path });
    // 扫描结果把指针修回去，下次直接走快路径
    expect(store.getAtomCard(file.path, "h1")).toBe(first.path);
  });

  it("提炼原子卡：两条内容相同的批注各自独立成卡，不因撞名合并", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, highlightOf("h1", "复利效应", 2));
    await store.addHighlight(file, highlightOf("h2", "长期投资", 8));

    const make = (annotationId: string) => ({
      annotationId,
      mode: "md" as const,
      quote: "复利效应",
      content: "同一个想法",
      tags: [],
    });

    const a = await store.createAtomCard(file, make("h1"), "卡片");
    const b = await store.createAtomCard(file, make("h2"), "卡片");
    if (a.status !== "created" || b.status !== "created") {
      throw new Error("expected created");
    }

    // 文件名撞了只能靠 inklightId 区分，不能把两条不同的想法并成一张
    expect(a.path).not.toBe(b.path);
    expect(vault.readText(a.path)).toContain("inklightId: md-h1");
    expect(vault.readText(b.path)).toContain("inklightId: md-h2");
  });

  it("提炼原子卡：目录留空时落到默认的「原子笔记」", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, { ...highlightOf("h1", "复利效应", 2), noteType: "insight" });

    const result = await store.createAtomCard(
      file,
      {
        annotationId: "h1",
        mode: "md",
        quote: "复利效应",
        content: "重读的成本，是复利公式里的分母。",
        noteType: "insight",
        tags: [],
      },
      "",
    );

    expect(result.status).toBe("created");
    if (result.status !== "created") {
      throw new Error("expected created");
    }
    expect(vault.has(result.path)).toBe(true);
    expect(result.path.startsWith("原子笔记/")).toBe(true);
  });

  it("提炼原子卡：老卡片没有 inklightId 时不误认，也不覆盖原文件", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, { ...highlightOf("h1", "复利效应", 2), noteType: "insight" });
    const legacy = '---\nsource: "[[读书笔记/复利]]"\n---\n\n重读的成本，是复利公式里的分母。\n';
    vault.writeText("卡片/重读的成本.md", legacy);

    const result = await store.createAtomCard(
      file,
      {
        annotationId: "h1",
        mode: "md",
        quote: "复利效应",
        content: "重读的成本，是复利公式里的分母。",
        noteType: "insight",
        tags: [],
      },
      "卡片",
    );

    expect(result.status).toBe("created");
    // 用户自己的卡片原样保留：插件只新建，绝不改写已有文件
    expect(vault.readText("卡片/重读的成本.md")).toBe(legacy);
  });

  it("提炼原子卡：正文只有空白时拒绝生成，不落盘也不写索引指针", async () => {
    const { store, vault, file } = await setup();
    await store.addHighlight(file, { ...highlightOf("h1", "复利效应", 2), noteType: "insight" });

    const result = await store.createAtomCard(
      file,
      {
        annotationId: "h1",
        mode: "md",
        quote: "复利效应",
        content: "   \n\t ",
        noteType: "insight",
        tags: [],
      },
      "卡片",
    );

    expect(result).toEqual({ status: "empty" });
    // 目录都不该被创建出来，更不该有空白卡片文件
    expect(vault.rawExists("卡片")).toBe(false);
    expect(store.getAtomCard(file.path, "h1")).toBeNull();
  });
});

describe("标签批量重命名 / 删除", () => {
  const OTHER_PATH = "读书笔记/另一篇.md";

  async function setupTwoFiles(options: Parameters<typeof createApp>[0] = {}) {
    const { app, vault } = createApp({
      files: {
        [MD_PATH]: "在复利效应的作用下，长期投资会放大收益。",
        [OTHER_PATH]: "长期投资需要耐心。",
      },
      ...options,
    });
    const store = new AnnotationStore(app);
    await store.initialize();
    return { vault, store };
  }

  it("重命名会改所有文件里的批注，并在目标标签已存在时合并", async () => {
    const { store, vault } = await setupTwoFiles();
    await store.addHighlight(vault.fileAt(MD_PATH), highlightOf("h1", "复利效应", 2, ["金融", "投资"]));
    await store.addHighlight(vault.fileAt(OTHER_PATH), highlightOf("h2", "长期投资", 0, ["金融"]));

    expect(await store.getTagUsage("金融")).toEqual({ fileCount: 2, annotationCount: 2 });
    const result = await store.renameTag("金融", "投资");

    expect(result.failed).toEqual([]);
    expect(result.changedFiles).toBe(2);
    expect(result.changedAnnotations).toBe(2);
    expect(result.newKey).toBe("投资");

    const first = vault.readJson<FileAnnotationDocument>(store.toSidecarPath(MD_PATH));
    const second = vault.readJson<FileAnnotationDocument>(store.toSidecarPath(OTHER_PATH));
    expect(first.highlights[0].tags).toEqual(["投资"]);
    expect(second.highlights[0].tags).toEqual(["投资"]);

    expect(store.getTagDictionary().map((entry) => entry.key)).toEqual(["投资"]);
    expect(store.getTagDisplayName("金融")).toBe("金融");
    expect(store.getTagDisplayName("投资")).toBe("投资");
  });

  it("仅改大小写时比较键不变，但批注写法与展示名一起更新", async () => {
    const { store, vault } = await setupTwoFiles();
    await store.addHighlight(vault.fileAt(MD_PATH), highlightOf("h1", "复利效应", 2, ["Foo"]));

    const result = await store.renameTag("foo", "foo");
    expect(result.changedFiles).toBe(1);
    expect(result.changedAnnotations).toBe(1);
    expect(result.newKey).toBe("foo");

    const document = vault.readJson<FileAnnotationDocument>(store.toSidecarPath(MD_PATH));
    expect(document.highlights[0].tags).toEqual(["foo"]);
    expect(store.getTagDisplayName("foo")).toBe("foo");
  });

  it("删除只摘掉标签，不删除批注；最后一个标签被删时字段一并移除", async () => {
    const { store, vault } = await setupTwoFiles();
    await store.addHighlight(vault.fileAt(MD_PATH), highlightOf("h1", "复利效应", 2, ["金融", "投资"]));
    await store.addHighlight(vault.fileAt(OTHER_PATH), highlightOf("h2", "长期投资", 0, ["金融"]));

    const result = await store.deleteTag("金融");
    expect(result.failed).toEqual([]);
    expect(result.changedFiles).toBe(2);
    expect(result.changedAnnotations).toBe(2);

    const first = vault.readJson<FileAnnotationDocument>(store.toSidecarPath(MD_PATH));
    const second = vault.readJson<FileAnnotationDocument>(store.toSidecarPath(OTHER_PATH));
    expect(first.highlights).toHaveLength(1);
    expect(first.highlights[0].tags).toEqual(["投资"]);
    expect(second.highlights).toHaveLength(1);
    expect(second.highlights[0]).not.toHaveProperty("tags");
    expect(store.getTagDictionary().map((entry) => entry.key)).toEqual(["投资"]);
  });

  it("单个文件写入失败时不中断其它文件，失败项如实返回", async () => {
    let failPath = "";
    const { store, vault } = await setupTwoFiles({
      failWrite: (path) => path === failPath,
    });
    await store.addHighlight(vault.fileAt(MD_PATH), highlightOf("h1", "复利效应", 2, ["金融"]));
    await store.addHighlight(vault.fileAt(OTHER_PATH), highlightOf("h2", "长期投资", 0, ["金融"]));
    // 两篇都写入成功后再打开失败开关，只拦另一篇的 sidecar
    failPath = store.toSidecarPath(OTHER_PATH);

    const result = await store.renameTag("金融", "投资");
    expect(result.changedFiles).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].filePath).toBe(OTHER_PATH);

    const first = vault.readJson<FileAnnotationDocument>(store.toSidecarPath(MD_PATH));
    expect(first.highlights[0].tags).toEqual(["投资"]);
    // 失败文件保留原标签，不能出现「改一半还报成功」
    expect(vault.readJson<FileAnnotationDocument>(failPath).highlights[0].tags).toEqual(["金融"]);
  });
});

describe("toSidecarPath", () => {
  it("短路径用可读的 legacy 命名（路径段以 __ 连接）", async () => {
    const { store } = await setup();
    expect(store.toSidecarPath("读书笔记/复利.md")).toBe(
      `${SIDECAR_DIR}/%E8%AF%BB%E4%B9%A6%E7%AC%94%E8%AE%B0__%E5%A4%8D%E5%88%A9.md.json`,
    );
  });

  it("超长文件名改用 compact 命名，避免超出文件系统上限", async () => {
    const { store } = await setup();
    const longPath = `${"很长的目录名".repeat(20)}/笔记.md`;
    const sidecar = store.toSidecarPath(longPath);

    expect(sidecar).toContain("--");
    expect(sidecar.length).toBeLessThan(180);
  });

  it("同一路径大小写不同映射到同一个 sidecar，避免双份数据", async () => {
    const { store } = await setup();
    expect(store.toSidecarPath("Notes/A.md")).toBe(store.toSidecarPath("notes/a.md"));
  });
});
