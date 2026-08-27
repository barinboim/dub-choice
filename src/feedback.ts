/**
 * Обратная связь: кнопка в подвале → форма → отправка на свой сервер,
 * который уже передаёт сообщение в Telegram владельцу.
 *
 * **Токена бота здесь нет и быть не может.** Сайт статический, всё, что
 * попадает в бандл, читается любым посетителем; с токеном бота чужой
 * человек получил бы доступ к переписке и мог бы слать сообщения от его
 * имени. Токен живёт только на VPS — тем же способом, каким
 * дашборд-воронка ходит в GoatCounter через Caddy с Bearer-токеном
 * (см. CLAUDE.md, «Аналитика»).
 *
 * К тексту игрока автоматически прикладывается технический отчёт
 * (`diagnostics.ts`): браузер, устройство, что сломалось. Спрашивать это
 * у человека бессмысленно — назовёт неточно или бросит форму.
 */
import { buildReport, type DiagnosticContext } from "./diagnostics";
import { note } from "./journey";
import { t } from "./i18n";

/**
 * Приёмник обратной связи на своём VPS. Пустая строка = отправка выключена,
 * форма тогда честно предлагает написать в Telegram руками.
 */
const FEEDBACK_ENDPOINT = "https://stats.barinbo.im:8446/feedback";

/** Куда отправлять человека, если сервер недоступен. */
const FALLBACK_CHANNEL = "https://t.me/barinboimgpt";

/** Что именно сломалось — заполняется страницей, если есть чем. */
let context: DiagnosticContext = {};

export function setFeedbackContext(next: DiagnosticContext): void {
  context = next;
}

export function initFeedback(): void {
  // Падения записываем всегда, даже если подвала на странице нет: без них
  // в отчёте остаётся «всё сломалось», а не строка с настоящей причиной.
  window.addEventListener("error", (e) => note(`сбой JS: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => note(`сбой JS (промис): ${describeReason(e.reason)}`));

  // Кнопок может быть несколько: подвал есть на всех страницах, а в студии
  // о бете спрашивают ещё и на первом экране — форма у них одна.
  for (const el of document.querySelectorAll("[data-feedback]")) {
    el.addEventListener("click", openFeedbackForm);
  }

  // Кнопки в подвале нет на карточке пака, на экране дубляжа и на премьере
  // (подвал живёт только на home) — а поймать баг человек может именно там.
  // Ctrl/Cmd+Shift+F открывает форму с любого экрана обоих документов.
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFeedbackForm();
    }
  });
}

function describeReason(reason: unknown): string {
  return reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
}

export function openFeedbackForm(): void {
  if (document.getElementById("feedback-modal")) return;

  const backdrop = document.createElement("div");
  backdrop.id = "feedback-modal";
  backdrop.className = "modal-backdrop";

  const card = document.createElement("div");
  card.className = "modal-card feedback-card";

  const title = document.createElement("h3");
  title.className = "modal-title";
  title.textContent = t("feedbackTitle");

  const hint = document.createElement("p");
  hint.className = "feedback-hint";
  hint.textContent = t("feedbackHint");

  const text = document.createElement("textarea");
  text.className = "feedback-text";
  text.rows = 5;
  text.placeholder = t("feedbackPlaceholder");

  const contact = document.createElement("input");
  contact.type = "text";
  contact.className = "feedback-contact";
  contact.placeholder = t("feedbackContact");

  // Отчёт показываем целиком: скрытый сбор данных в бете быстро
  // становится репутационной проблемой, а тут скрывать нечего.
  const details = document.createElement("details");
  details.className = "feedback-details";
  const summary = document.createElement("summary");
  summary.textContent = t("feedbackWhatIsSent");
  const pre = document.createElement("pre");
  pre.className = "feedback-report";
  pre.textContent = "…";
  // Отчёт собирается асинхронно (UA-CH и оценка хранилища — промисы), но
  // ждать его игроку незачем: форма открывается сразу, текст доезжает сам.
  void buildReport(context).then((report) => {
    pre.textContent = report;
  });
  details.append(summary, pre);

  const status = document.createElement("p");
  status.className = "feedback-status";
  status.hidden = true;

  const send = document.createElement("button");
  send.type = "button";
  send.className = "btn btn-primary";
  send.textContent = t("feedbackSend");

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-text";
  cancel.textContent = t("feedbackCancel");
  cancel.addEventListener("click", () => backdrop.remove());

  const row = document.createElement("div");
  row.className = "feedback-actions";
  row.append(send, cancel);

  send.addEventListener("click", () => {
    void submit(text.value.trim(), contact.value.trim(), pre, send, status);
  });

  card.append(title, hint, text, contact, details, row, status);
  backdrop.append(card);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.append(backdrop);
  text.focus();
}

async function submit(
  message: string,
  contact: string,
  pre: HTMLElement,
  send: HTMLButtonElement,
  status: HTMLElement
): Promise<void> {
  if (!message) {
    showStatus(status, t("feedbackEmpty"), true);
    return;
  }
  send.disabled = true;
  showStatus(status, t("feedbackSending"), false);
  // Пересобираем на отправку, а не берём показанное: пока человек писал,
  // он мог успеть что-то сделать — и это «что-то» обычно и есть причина.
  const report = await buildReport(context);
  pre.textContent = report;
  try {
    if (!FEEDBACK_ENDPOINT) throw new Error("endpoint not configured");
    const res = await fetch(FEEDBACK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, contact, report, page: location.pathname }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showStatus(status, t("feedbackSent"), false);
    send.hidden = true;
  } catch (err) {
    console.error(err);
    // Сервер лёг — не теряем написанное: кладём в буфер и показываем,
    // куда это отправить руками.
    void navigator.clipboard?.writeText(`${message}\n\n${contact}\n\n${report}`);
    showStatus(status, t("feedbackFailed"), true);
    const link = document.createElement("a");
    link.href = FALLBACK_CHANNEL;
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "btn btn-pill btn-sm";
    link.textContent = t("feedbackOpenTelegram");
    status.append(document.createElement("br"), link);
    send.disabled = false;
  }
}

function showStatus(status: HTMLElement, message: string, isError: boolean): void {
  status.textContent = message;
  status.classList.toggle("error", isError);
  status.hidden = false;
}
