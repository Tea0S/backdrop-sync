import { requestUrl, Notice } from "obsidian";

import type { PullPack } from "./types";



const MAX_429_RETRY_WAIT_SEC = 60;



function sleep(ms: number): Promise<void> {

  return new Promise((resolve) => window.setTimeout(resolve, ms));

}



function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {

  if (!headers) return undefined;

  const want = name.toLowerCase();

  for (const [k, v] of Object.entries(headers)) {

    if (k.toLowerCase() === want) return v;

  }

  return undefined;

}



/** Parse Retry-After (seconds or HTTP-date). Returns seconds to wait, minimum 1. */

export function parseRetryAfterSeconds(raw: string | undefined, fallbackSec = 5): number {

  if (!raw) return fallbackSec;

  const trimmed = String(raw).trim();

  const asInt = Number.parseInt(trimmed, 10);

  if (Number.isFinite(asInt) && String(asInt) === trimmed) {

    return Math.max(1, asInt);

  }

  const when = Date.parse(trimmed);

  if (Number.isFinite(when)) {

    return Math.max(1, Math.ceil((when - Date.now()) / 1000));

  }

  return fallbackSec;

}



export class BackdropApiError extends Error {

  status: number;

  code?: string;

  body: Record<string, unknown>;

  retryAfterSec?: number;



  constructor(

    message: string,

    status: number,

    body: Record<string, unknown> = {},

    retryAfterSec?: number

  ) {

    super(message);

    this.status = status;

    this.code = typeof body.code === "string" ? body.code : undefined;

    this.body = body;

    this.retryAfterSec = retryAfterSec;

  }

}



export class BackdropClient {

  constructor(

    private getBaseUrl: () => string,

    private getApiKey: () => string

  ) {}



  private base(): string {

    return String(this.getBaseUrl() || "").replace(/\/+$/, "");

  }



  private async request<T>(

    method: string,

    path: string,

    body?: unknown,

    opts: { retryOn429?: boolean } = {}

  ): Promise<T> {

    const retryOn429 = opts.retryOn429 !== false;

    const key = this.getApiKey().trim();

    if (!key) throw new BackdropApiError("API key is not set.", 401);

    const base = this.base();
    if (!base || !/^https?:\/\//i.test(base)) {
      throw new BackdropApiError("API base URL is not set or invalid.", 400);
    }

    const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;

    const res = await requestUrl({

      url,

      method,

      headers: {

        Authorization: `Bearer ${key}`,

        "Content-Type": "application/json",

        Accept: "application/json",

      },

      body: body !== undefined ? JSON.stringify(body) : undefined,

      throw: false,

    });

    let parsed: Record<string, unknown> = {};

    try {

      parsed = res.json as Record<string, unknown>;

    } catch {

      parsed = {};

    }

    if (res.status < 200 || res.status >= 300) {

      const msg =

        (typeof parsed.error === "string" && parsed.error) ||

        (typeof parsed.message === "string" && parsed.message) ||

        `HTTP ${res.status}`;

      const retryAfterSec =

        res.status === 429

          ? parseRetryAfterSeconds(headerValue(res.headers, "Retry-After"))

          : undefined;

      if (res.status === 429 && retryOn429 && retryAfterSec != null && retryAfterSec <= MAX_429_RETRY_WAIT_SEC) {

        new Notice(`BackDrop: rate limited — retrying in ${retryAfterSec}s…`);

        await sleep(retryAfterSec * 1000);

        return this.request<T>(method, path, body, { retryOn429: false });

      }

      throw new BackdropApiError(msg, res.status, parsed, retryAfterSec);

    }

    return parsed as T;

  }



  me() {

    return this.request<{ discord_user_id: string; display_name: string | null }>("GET", "/api/v1/obsidian/me");

  }



  worlds() {

    return this.request<{

      worlds: Array<{

        id: string;

        slug: string;

        name: string;

        can_edit_wiki: boolean;

        can_edit_timeline: boolean;

      }>;

    }>("GET", "/api/v1/obsidian/worlds");

  }



  pull(worldSlug: string) {

    return this.request<PullPack>("GET", `/api/v1/obsidian/worlds/${encodeURIComponent(worldSlug)}/pull`);

  }



  createWikiCategory(worldSlug: string, payload: { name: string; slug?: string }) {

    return this.request<{ category: { id: string; slug: string; name: string; is_system?: boolean } }>(

      "POST",

      `/api/v1/obsidian/worlds/${encodeURIComponent(worldSlug)}/wiki/categories`,

      payload

    );

  }



  createWikiTag(worldSlug: string, payload: { name: string; slug?: string }) {

    return this.request<{ tag: { id: string; slug: string; name: string } }>(

      "POST",

      `/api/v1/obsidian/worlds/${encodeURIComponent(worldSlug)}/wiki/tags`,

      payload

    );

  }



  createWikiArticle(worldSlug: string, payload: Record<string, unknown>) {

    return this.request<{ article: Record<string, unknown> }>(

      "POST",

      `/api/v1/obsidian/worlds/${encodeURIComponent(worldSlug)}/wiki/articles`,

      payload

    );

  }



  updateWikiArticle(worldSlug: string, articleId: string, payload: Record<string, unknown>) {

    return this.request<{ article: Record<string, unknown> }>(

      "PUT",

      `/api/v1/obsidian/worlds/${encodeURIComponent(worldSlug)}/wiki/articles/${encodeURIComponent(articleId)}`,

      payload

    );

  }



  createTimelineEvent(worldSlug: string, payload: Record<string, unknown>) {

    return this.request<{ event: Record<string, unknown> }>(

      "POST",

      `/api/v1/obsidian/worlds/${encodeURIComponent(worldSlug)}/timeline/events`,

      payload

    );

  }



  updateTimelineEvent(worldSlug: string, eventId: string, payload: Record<string, unknown>) {

    return this.request<{ event: Record<string, unknown> }>(

      "PUT",

      `/api/v1/obsidian/worlds/${encodeURIComponent(worldSlug)}/timeline/events/${encodeURIComponent(eventId)}`,

      payload

    );

  }



  async uploadAsset(

    worldSlug: string,

    filename: string,

    contentType: string,

    data: ArrayBuffer

  ): Promise<string> {

    const prep = await this.request<{

      uploadUrl: string;

      publicUrl: string;

      maxBytes?: number;

    }>("POST", `/api/v1/obsidian/worlds/${encodeURIComponent(worldSlug)}/assets/upload-url`, {

      filename,

      contentType,

    });

    if (prep.maxBytes && data.byteLength > prep.maxBytes) {

      throw new BackdropApiError(`File exceeds max size (${prep.maxBytes} bytes).`, 400);

    }

    const put = await requestUrl({

      url: prep.uploadUrl,

      method: "PUT",

      headers: { "Content-Type": contentType },

      body: data,

      throw: false,

    });

    if (put.status < 200 || put.status >= 300) {

      throw new BackdropApiError(`Upload failed (HTTP ${put.status}).`, put.status);

    }

    await this.request("POST", `/api/v1/obsidian/worlds/${encodeURIComponent(worldSlug)}/assets`, {

      filename,

      url: prep.publicUrl,

    });

    return prep.publicUrl;

  }

}



export function noticeError(err: unknown, prefix = "BackDrop") {

  if (err instanceof BackdropApiError && err.status === 429) {

    const wait = err.retryAfterSec ?? 5;

    new Notice(`${prefix}: rate limited — try again in ${wait}s.`);

    return;

  }

  const msg = err instanceof Error ? err.message : String(err);

  new Notice(`${prefix}: ${msg}`);

}



export function sleepMs(ms: number): Promise<void> {

  return sleep(ms);

}


