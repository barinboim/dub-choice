/**
 * Диалоги вокруг своего пака: «Опубликовать пак» и «Скачать пак».
 *
 * Разметки в HTML у них нет намеренно, и это не лень. Обе кнопки живут
 * сразу в двух документах — на таймлайне студии (`studio.html`) и на
 * премьере игры (`index.html`), — а `$()` в этом проекте возвращает `null`
 * молча, и забытый в одном из файлов блок роняет всё приложение, чего
 * `tsc` не ловит (CLAUDE.md, «Грабли»). Один модуль, собирающий диалог
 * сам, забыть невозможно. Классы (`modal-*`, `btn-*`) — из общего
 * `style.css`, который грузят оба документа.
 */
import { t } from "../i18n";
import { note } from "../journey";
import { downloadPackZip, packFileName, packFolderName, packToZipBlob, saveZip } from "./zip";
import { TOO_BIG, publishPack, type PublishStage } from "./publish";
import { trackEvent } from "../analytics";
import type { DubPack } from "./types";

/** Один диалог за раз: второй клик по кнопке не должен плодить попапы. */
function openModal(id: string): { card: HTMLElement; close: () => void } | null {
  if (document.getElementById(id)) return null;
  const backdrop = document.createElement("div");
  backdrop.id = id;
  backdrop.className = "modal-backdrop";
  const card = document.createElement("div");
  card.className = "modal-card own-pack-card";
  backdrop.append(card);
  const close = (): void => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.body.append(backdrop);
  return { card, close };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = ""
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Кнопка-вариант с заголовком и пояснением — как в попапе экспорта WAV. */
function option(titleKey: Parameters<typeof t>[0], hintKey: Parameters<typeof t>[0]): HTMLButtonElement {
  const button = el("button", "modal-option");
  button.type = "button";
  button.append(el("span", "modal-option-title", t(titleKey)), el("small", "", t(hintKey)));
  return button;
}

function progressBar(): { wrap: HTMLElement; label: HTMLElement; fill: HTMLElement; set: (text: string, ratio: number) => void } {
  const wrap = el("div", "own-pack-progress");
  const label = el("p", "own-pack-stage");
  const bar = el("div", "studio-progress-bar");
  const fill = el("div", "studio-progress-fill");
  bar.append(fill);
  wrap.append(label, bar);
  return {
    wrap,
    label,
    fill,
    set(text, ratio) {
      label.textContent = text;
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    },
  };
}

// ---------- Опубликовать пак ----------

/**
 * Согласие спрашиваем явно и галочкой, а не мелким шрифтом под кнопкой:
 * дальше пак уезжает на чужой сервер и может стать виден всему интернету —
 * это ровно тот случай, когда «он же сам нажал» плохое оправдание.
 */
export function openPublishModal(pack: DubPack): void {
  const modal = openModal("publish-modal");
  if (!modal) return;
  const { card, close } = modal;
  note("открыл форму публикации пака");

  const title = el("h3", "modal-title", t("publishTitle"));
  const intro = el("p", "own-pack-text", t("publishIntro"));
  const rights = el("p", "own-pack-text own-pack-warn", t("publishRights"));

  const authorLabel = el("label", "own-pack-field");
  authorLabel.append(el("span", "", t("publishAuthor")));
  const author = el("input", "");
  author.type = "text";
  author.placeholder = t("publishAuthorPlaceholder");
  author.value = pack.authors[0] ?? "";
  authorLabel.append(author);

  const consentLabel = el("label", "own-pack-consent");
  const consent = el("input", "");
  consent.type = "checkbox";
  consentLabel.append(consent, el("span", "", t("publishConsent")));

  const bar = progressBar();
  bar.wrap.hidden = true;

  const status = el("p", "own-pack-status");
  status.hidden = true;

  const ok = el("button", "btn btn-primary", t("publishOk"));
  ok.type = "button";
  const cancel = el("button", "btn btn-text", t("modalCancel"));
  cancel.type = "button";
  cancel.addEventListener("click", close);
  const actions = el("div", "own-pack-actions");
  actions.append(ok, cancel);

  const fail = (message: string): void => {
    status.textContent = message;
    status.classList.add("error");
    status.hidden = false;
  };

  ok.addEventListener("click", () => {
    const name = author.value.trim();
    if (!name) return fail(t("publishNeedAuthor"));
    if (!consent.checked) return fail(t("publishNeedConsent"));

    status.hidden = true;
    status.classList.remove("error");
    ok.disabled = true;
    author.disabled = true;
    consent.disabled = true;
    bar.wrap.hidden = false;
    trackEvent("pack-publish/start");

    const onStage = (stage: PublishStage): void => {
      if (stage.kind === "packing") bar.set(t("publishPacking"), 0.05);
      // Упаковка — это секунды, отправка — минуты: полоску отдаём ей почти
      // целиком, иначе она стоит на месте всё то время, когда идёт работа.
      else bar.set(t("publishUploading", { percent: stage.percent }), 0.1 + (stage.percent / 100) * 0.9);
    };

    // Имя из формы важнее того, что лежало в паке: галерея подпишет пак
    // именно им, и переспрашивать после отправки будет некого.
    const submitted: DubPack = { ...pack, authors: [name] };
    void publishPack(submitted, { author: name, source: pack.sourceUrl }, onStage)
      .then(() => {
        note("отправил пак на модерацию");
        trackEvent("pack-publish/done");
        bar.wrap.hidden = true;
        status.textContent = t("publishSent");
        status.hidden = false;
        ok.hidden = true;
        cancel.textContent = t("close");
      })
      .catch((err: unknown) => {
        console.error(err);
        trackEvent("pack-publish/failed");
        bar.wrap.hidden = true;
        const detail = err instanceof Error ? err.message : String(err);
        // «Пак не влез» — не сбой отправки, а понятная причина с цифрами:
        // показываем её своим текстом, а не «не удалось отправить: …».
        if (detail.startsWith(TOO_BIG)) {
          const [size, limit] = detail.slice(TOO_BIG.length).split("|");
          fail(t("publishTooBig", { size, limit }));
        } else {
          fail(t("publishFailed", { error: detail }));
        }
        ok.disabled = false;
        author.disabled = false;
        consent.disabled = false;
      });
  });

  card.append(title, intro, rights, authorLabel, consentLabel, bar.wrap, actions, status);
  author.focus();
}

// ---------- Скачать пак ----------

export function openDownloadModal(pack: DubPack): void {
  const modal = openModal("download-pack-modal");
  if (!modal) return;
  const { card, close } = modal;

  const title = el("h3", "modal-title", t("downloadModalTitle"));
  const options = el("div", "modal-options");
  const plain = option("downloadOptDub", "downloadOptDubHint");
  const tcv = option("downloadOptTcv", "downloadOptTcvHint");
  options.append(plain, tcv);

  const cancel = el("button", "btn btn-text", t("modalCancel"));
  cancel.type = "button";
  cancel.addEventListener("click", close);

  plain.addEventListener("click", () => {
    trackEvent("pack-download/dub");
    void downloadPackZip(pack);
    close();
  });
  tcv.addEventListener("click", () => {
    trackEvent("pack-download/tcv");
    void runTcvExport(pack, card, cancel);
  });

  card.append(title, options, cancel);
}

/**
 * Пережатие в Theora идёт минутами, поэтому попап не закрывается: он
 * превращается в экран прогресса. Закрыть его посреди работы = потерять
 * всё сделанное, и кнопка отмены на это время убирается.
 */
async function runTcvExport(pack: DubPack, card: HTMLElement, cancel: HTMLElement): Promise<void> {
  const bar = progressBar();
  const status = el("p", "own-pack-status");
  status.hidden = true;
  // Про разовость закачки говорим сразу, а не когда полоска уже ползёт:
  // 32 МБ на телефоне — это решение, и принимать его человек должен
  // до того, как ждать начал.
  const engineNote = el("p", "own-pack-note", t("tcvEngineNote"));
  card.replaceChildren(
    el("h3", "modal-title", t("tcvTitle")),
    el("p", "own-pack-text", t("tcvHint")),
    bar.wrap,
    engineNote,
    status
  );
  note("собирает пак для The Choicer Voicer");

  try {
    bar.set(t("tcvStageEngine"), 0.02);
    // Модуль подтягивается по требованию: обёртку ffmpeg.wasm незачем
    // возить в бандле игры тем, кто про The Choicer Voicer и не спрашивал.
    const { TCV_ZIP_OPTIONS, packToTcv } = await import("./tcv");
    const converted = await packToTcv(pack, (stage, ratio, vars) => {
      bar.set(t(stage, vars), ratio);
      // Кодировщик поднялся — дальше подсказка про него только мешает.
      engineNote.hidden = !stage.startsWith("tcvStageEngine");
    });
    bar.set(t("tcvStageZip"), 0.98);
    const blob = await packToZipBlob(converted, { ...TCV_ZIP_OPTIONS, folder: packFolderName(pack) });
    saveZip(blob, `${packFileName(pack)}-tcv.zip`);
    bar.set(t("tcvDone"), 1);
    trackEvent("pack-download/tcv-done");
    cancel.textContent = t("close");
    card.append(cancel);
  } catch (err) {
    console.error(err);
    trackEvent("pack-download/tcv-failed");
    const detail = err instanceof Error ? err.message : String(err);
    // Единственная ошибка, о которой есть что сказать по делу, несёт размер
    // прямо в сообщении: `tcvTooBig:123 МБ`.
    const big = detail.startsWith("tcvTooBig:");
    status.textContent = big
      ? t("tcvTooBig", { size: detail.slice("tcvTooBig:".length) })
      : t("tcvFailed", { error: detail });
    status.classList.add("error");
    status.hidden = false;
    bar.wrap.hidden = true;
    card.append(cancel);
  }
}
