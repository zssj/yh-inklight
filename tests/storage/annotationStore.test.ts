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
    expect(index.version).toBe(2);
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
    expect(url.hostname).toBe("inklight-epub");
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
