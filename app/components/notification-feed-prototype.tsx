// PROTOTYPE: throwaway, for "What does the Notification Feed look like in Cadence?" (#43).
// Lives on the prototype/notification-feed branch only. Never merge.
//
// Three variants of the Notification Feed, switchable via `?variant=A|B|C` (or the
// floating bar / ← → keys). Every variant reads the real Knock feed for the user the
// DevUI selects, with the public key + a signed user token, exactly as production would.
//   A  Bell popover   — bell in the sidebar header, badge = unseen, opening marks seen
//   B  Inbox drawer   — sidebar item, badge = unread, right-hand slide-over, Unread/All tabs
//   C  Full page      — /notifications page, sidebar dot only, filters + bulk actions, toasts
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NavLink, useFetcher, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import {
  Bell,
  BellDot,
  Check,
  ChevronLeft,
  ChevronRight,
  GraduationCap,
  Inbox,
  MessageSquare,
  Receipt,
  UsersRound,
  X,
} from "lucide-react";
import { cn } from "~/lib/utils";

// ─── Knock headless feed ───────────────────────────────────────────────────

export type FeedConfig = {
  knockUserId: string;
  userToken: string;
  publicApiKey: string;
  feedChannelId: string;
};

type Entry = {
  id: string;
  inserted_at: string;
  seen_at: string | null;
  read_at: string | null;
  data: Record<string, any>;
};
type Meta = { unread_count: number; unseen_count: number; total_count: number };

const API = "https://api.knock.app/v1";

function useKnockFeed(config: FeedConfig | null) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [meta, setMeta] = useState<Meta>({ unread_count: 0, unseen_count: 0, total_count: 0 });
  const [loaded, setLoaded] = useState(false);

  const headers = useMemo(
    () =>
      config && {
        Authorization: `Bearer ${config.publicApiKey}`,
        "X-Knock-User-Token": config.userToken,
        "Content-Type": "application/json",
      },
    [config]
  );

  const refresh = useCallback(async () => {
    if (!config || !headers) return;
    const res = await fetch(
      `${API}/users/${config.knockUserId}/feeds/${config.feedChannelId}?page_size=50`,
      { headers }
    );
    if (!res.ok) return;
    const body = await res.json();
    setEntries(body.entries);
    setMeta(body.meta);
    setLoaded(true);
  }, [config, headers]);

  // DevUI user switch → new token → reload. Poll for new arrivals (real-time is a later question).
  useEffect(() => {
    setEntries([]);
    setLoaded(false);
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  const mark = useCallback(
    async (status: "seen" | "read" | "unread", ids: string[]) => {
      if (!headers || ids.length === 0) return; // empty message_ids → 422
      // Optimistic, so the UI reacts instantly.
      const now = new Date().toISOString();
      setEntries((es) =>
        es.map((e) =>
          !ids.includes(e.id)
            ? e
            : status === "seen"
              ? { ...e, seen_at: e.seen_at ?? now }
              : status === "read"
                ? { ...e, read_at: now, seen_at: e.seen_at ?? now }
                : { ...e, read_at: null }
        )
      );
      await fetch(`${API}/messages/batch/${status}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ message_ids: ids }),
      });
      refresh();
    },
    [headers, refresh]
  );

  // Counts derived from loaded entries so optimistic updates show immediately.
  const unread = entries.filter((e) => !e.read_at).length;
  const unseen = entries.filter((e) => !e.seen_at).length;

  return { entries, meta, loaded, unread, unseen, mark, refresh };
}

type Feed = ReturnType<typeof useKnockFeed>;
const FeedContext = createContext<Feed | null>(null);
export const useFeed = () => useContext(FeedContext);

// ─── Catalogue rendering ───────────────────────────────────────────────────

type Group = "Refunds" | "Team" | "Discussions" | "Enrollments";

function describe(e: Entry): { title: React.ReactNode; detail?: string; group: Group; icon: React.ReactNode } {
  const d = e.data;
  const b = (s: string) => <span className="font-semibold">{s}</span>;
  switch (d.kind) {
    case "refund-approved":
      return { title: <>Your Refund Request for {b(d.courseTitle)} was approved</>, detail: d.note || undefined, group: "Refunds", icon: <Receipt className="size-4" /> };
    case "refund-declined":
      return { title: <>Your Refund Request for {b(d.courseTitle)} was declined</>, detail: `${d.note} You can ask again.`, group: "Refunds", icon: <Receipt className="size-4" /> };
    case "open-refund-request":
      return { title: <>{b(d.actorName)} asked for a {d.amount} refund on {b(d.courseTitle)}</>, detail: `“${d.reason}”`, group: "Refunds", icon: <Receipt className="size-4" /> };
    case "seat-claimed":
      return { title: <>{b(d.actorName)} claimed a Seat on {b(d.courseTitle)}</>, detail: `${d.seatsLeft} Seats left`, group: "Team", icon: <UsersRound className="size-4" /> };
    case "new-enrollment":
      return { title: <>{b(d.actorName)} enrolled in {b(d.courseTitle)}</>, group: "Enrollments", icon: <GraduationCap className="size-4" /> };
    case "discussion-question":
      return { title: <>{b(d.actorName)} asked a question on {b(d.lessonTitle)}</>, detail: `“${d.snippet}”`, group: "Discussions", icon: <MessageSquare className="size-4" /> };
    case "discussion-reply":
      return { title: <>{b(d.actorName ?? d.replierName)} replied to your question on {b(d.lessonTitle)}</>, detail: d.snippet ?? d.questionExcerpt, group: "Discussions", icon: <MessageSquare className="size-4" /> };
    default:
      return { title: <>Unknown Notification ({String(d.kind)})</>, group: "Discussions", icon: <Bell className="size-4" /> };
  }
}

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function initials(name?: string) {
  return (name ?? "?").split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
}

function useOpenEntry(feed: Feed, after?: () => void) {
  const navigate = useNavigate();
  return (e: Entry) => {
    if (!e.read_at) feed.mark("read", [e.id]);
    after?.();
    if (e.data.url) navigate(e.data.url);
  };
}

function SeedButton({ className }: { className?: string }) {
  const fetcher = useFetcher<{ seeded?: number; error?: string }>();
  const feed = useFeed();
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.error) toast.error(fetcher.data.error);
      else toast.success(`Sent ${fetcher.data.seeded} sample Notifications. They land in a few seconds.`);
      const t = setTimeout(() => feed?.refresh(), 3000);
      return () => clearTimeout(t);
    }
  }, [fetcher.state, fetcher.data]);
  return (
    <fetcher.Form method="post" action="/api/prototype-notifications-seed" className={className}>
      <button className="text-xs underline text-muted-foreground hover:text-foreground" disabled={fetcher.state !== "idle"}>
        {fetcher.state !== "idle" ? "Sending…" : "Send sample Notifications"}
      </button>
    </fetcher.Form>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-muted-foreground">
      <Inbox className="size-8 opacity-40" />
      You're all caught up.
      <SeedButton />
    </div>
  );
}

// ─── Variant A: bell popover ───────────────────────────────────────────────

function VariantA_Bell({ feed }: { feed: Feed }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const openEntry = useOpenEntry(feed, () => setOpen(false));
  const [filter, setFilter] = useState<"all" | "unread" | "read">("all");
  const filtered = feed.entries.filter((e) =>
    filter === "all" ? true : filter === "unread" ? !e.read_at : !!e.read_at
  );

  // Opening the popover marks everything seen → the badge clears; unread dots stay.
  useEffect(() => {
    if (open) feed.mark("seen", feed.entries.filter((e) => !e.seen_at).map((e) => e.id));
  }, [open]);
  useEffect(() => {
    const onDown = (ev: MouseEvent) => ref.current && !ref.current.contains(ev.target as Node) && setOpen(false);
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div ref={ref} className="relative ml-auto">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent"
        title="Notifications"
      >
        <Bell className="size-5" />
        {feed.unseen > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {feed.unseen > 9 ? "9+" : feed.unseen}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-10 z-50 w-96 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl">
          <div className="flex items-center gap-2 border-b px-4 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            <select
              value={filter}
              onChange={(ev) => setFilter(ev.target.value as typeof filter)}
              className="rounded border bg-background px-1.5 py-0.5 text-xs"
            >
              <option value="all">All</option>
              <option value="unread">Unread</option>
              <option value="read">Read</option>
            </select>
            <span className="flex-1" />
            {feed.unread > 0 && (
              <button
                className="text-xs text-primary hover:underline"
                onClick={() => feed.mark("read", feed.entries.filter((e) => !e.read_at).map((e) => e.id))}
              >
                Mark all as read
              </button>
            )}
          </div>
          <div className="max-h-[28rem] overflow-y-auto">
            {filtered.length === 0 && <Empty />}
            {filtered.slice(0, 15).map((e) => {
              const n = describe(e);
              return (
                <button
                  key={e.id}
                  onClick={() => openEntry(e)}
                  className={cn("flex w-full gap-3 border-b px-4 py-3 text-left text-sm hover:bg-muted", !e.read_at && "bg-primary/5")}
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                    {initials(e.data.actorName)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2">{n.title}</div>
                    {n.detail && <div className="mt-0.5 truncate text-xs text-muted-foreground">{n.detail}</div>}
                    <div className="mt-1 text-xs text-muted-foreground">{ago(e.inserted_at)}</div>
                  </div>
                  {!e.read_at && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Variant B: inbox drawer ───────────────────────────────────────────────

function dayBucket(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return "Earlier";
}

function VariantB_NavItem({ feed, onOpen }: { feed: Feed; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      <Inbox className="size-4" />
      Notifications
      {feed.unread > 0 && (
        <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
          {feed.unread}
        </span>
      )}
    </button>
  );
}

function VariantB_Drawer({ feed, open, onClose }: { feed: Feed; open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"unread" | "all">("unread");
  const openEntry = useOpenEntry(feed, onClose);
  useEffect(() => {
    if (open) feed.mark("seen", feed.entries.filter((e) => !e.seen_at).map((e) => e.id));
  }, [open]);
  if (!open) return null;

  const shown = feed.entries.filter((e) => tab === "all" || !e.read_at);
  const buckets = ["Today", "Yesterday", "Earlier"].map((b) => [b, shown.filter((e) => dayBucket(e.inserted_at) === b)] as const);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <aside className="flex h-full w-[440px] flex-col border-l bg-background shadow-2xl" onClick={(ev) => ev.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="text-lg font-semibold">Notifications</h2>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-muted"><X className="size-5" /></button>
        </div>
        <div className="flex items-center gap-1 border-b px-5 py-2">
          {(["unread", "all"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn("rounded-md px-3 py-1 text-sm capitalize", tab === t ? "bg-muted font-semibold" : "text-muted-foreground")}
            >
              {t}{t === "unread" && ` (${feed.unread})`}
            </button>
          ))}
          {feed.unread > 0 && (
            <button
              className="ml-auto text-xs text-primary hover:underline"
              onClick={() => feed.mark("read", feed.entries.filter((e) => !e.read_at).map((e) => e.id))}
            >
              Mark all as read
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {shown.length === 0 && <Empty />}
          {buckets.map(([label, es]) =>
            es.length === 0 ? null : (
              <section key={label} className="mb-3">
                <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
                {es.map((e) => {
                  const n = describe(e);
                  return (
                    <div
                      key={e.id}
                      onClick={() => openEntry(e)}
                      className={cn("group mb-2 cursor-pointer rounded-lg border p-3 hover:border-primary/50", !e.read_at && "border-primary/30 bg-primary/5")}
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 text-muted-foreground">{n.icon}</div>
                        <div className="min-w-0 flex-1 text-sm">
                          <div>{n.title}</div>
                          {n.detail && <blockquote className="mt-1.5 border-l-2 pl-2 text-xs text-muted-foreground">{n.detail}</blockquote>}
                          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="rounded bg-muted px-1.5 py-0.5">{n.group}</span>
                            {ago(e.inserted_at)}
                          </div>
                        </div>
                        <button
                          title={e.read_at ? "Mark as unread" : "Mark as read"}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            feed.mark(e.read_at ? "unread" : "read", [e.id]);
                          }}
                          className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100"
                        >
                          {e.read_at ? <BellDot className="size-4" /> : <Check className="size-4" />}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            )
          )}
        </div>
      </aside>
    </div>
  );
}

// ─── Variant C: full page ──────────────────────────────────────────────────

function VariantC_NavItem({ feed }: { feed: Feed }) {
  return (
    <NavLink
      to="/notifications"
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )
      }
    >
      {feed.unseen > 0 ? <BellDot className="size-4 text-primary" /> : <Bell className="size-4" />}
      Notifications
      {feed.unseen > 0 && <span className="ml-auto size-2 rounded-full bg-primary" />}
    </NavLink>
  );
}

// New arrivals while you're elsewhere in the app pop a toast (only in C).
function useArrivalToasts(feed: Feed, enabled: boolean) {
  const known = useRef<Set<string> | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (!feed.loaded) return;
    if (known.current === null || !enabled) {
      known.current = new Set(feed.entries.map((e) => e.id));
      return;
    }
    for (const e of feed.entries) {
      if (known.current.has(e.id)) continue;
      known.current.add(e.id);
      const n = describe(e);
      toast(n.title, {
        description: n.detail,
        action: e.data.url ? { label: "Open", onClick: () => { feed.mark("read", [e.id]); navigate(e.data.url); } } : undefined,
      });
    }
  }, [feed.entries, feed.loaded, enabled]);
}

export function NotificationsPage() {
  const feed = useFeed();
  const [filter, setFilter] = useState<Group | "All">("All");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const openEntry = useOpenEntry(feed!);

  // Visiting the page marks everything seen → the sidebar dot clears.
  useEffect(() => {
    if (feed?.loaded) feed.mark("seen", feed.entries.filter((e) => !e.seen_at).map((e) => e.id));
  }, [feed?.loaded, feed?.entries.length]);

  if (!feed) return <div className="p-8">Notification Feed unavailable (no user or Knock keys).</div>;

  const groups: (Group | "All")[] = ["All", "Refunds", "Team", "Discussions", "Enrollments"];
  const counts = Object.fromEntries(groups.map((g) => [g, feed.entries.filter((e) => g === "All" || describe(e).group === g).length]));
  const shown = feed.entries.filter((e) => filter === "All" || describe(e).group === filter);
  const sel = [...selected];

  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Notifications</h1>
          <p className="text-sm text-muted-foreground">{feed.unread} unread of {feed.entries.length}</p>
        </div>
        <SeedButton />
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {groups.filter((g) => g === "All" || counts[g] > 0).map((g) => (
          <button
            key={g}
            onClick={() => setFilter(g)}
            className={cn("rounded-full border px-3 py-1 text-sm", filter === g ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}
          >
            {g} <span className="opacity-70">{counts[g]}</span>
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-lg border">
        <div className="flex items-center gap-3 border-b bg-muted/50 px-4 py-2 text-sm">
          <input
            type="checkbox"
            checked={shown.length > 0 && shown.every((e) => selected.has(e.id))}
            onChange={(ev) => setSelected(ev.target.checked ? new Set(shown.map((e) => e.id)) : new Set())}
          />
          {sel.length > 0 ? (
            <>
              <span>{sel.length} selected</span>
              <button className="text-primary hover:underline" onClick={() => { feed.mark("read", sel); setSelected(new Set()); }}>Mark read</button>
              <button className="text-primary hover:underline" onClick={() => { feed.mark("unread", sel); setSelected(new Set()); }}>Mark unread</button>
            </>
          ) : (
            <span className="text-muted-foreground">Select to mark read or unread</span>
          )}
        </div>
        {shown.length === 0 && <Empty />}
        {shown.map((e) => {
          const n = describe(e);
          return (
            <div key={e.id} className={cn("flex items-center gap-3 border-b px-4 py-2.5 text-sm last:border-b-0 hover:bg-muted/50", !e.read_at && "font-medium")}>
              <input
                type="checkbox"
                checked={selected.has(e.id)}
                onChange={() => setSelected((s) => { const n = new Set(s); n.has(e.id) ? n.delete(e.id) : n.add(e.id); return n; })}
              />
              <span className={cn("size-2 shrink-0 rounded-full", e.read_at ? "bg-transparent" : "bg-primary")} />
              <span className="text-muted-foreground">{n.icon}</span>
              <button onClick={() => openEntry(e)} className="min-w-0 flex-1 truncate text-left">
                {n.title}
                {n.detail && <span className="ml-2 font-normal text-muted-foreground">{n.detail}</span>}
              </button>
              <span className="w-24 shrink-0 text-right text-xs font-normal text-muted-foreground">{new Date(e.inserted_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Wiring ────────────────────────────────────────────────────────────────

const VARIANTS = [
  { key: "A", name: "Bell popover" },
  { key: "B", name: "Inbox drawer" },
  { key: "C", name: "Full page" },
];

export function useVariant() {
  const location = useLocation();
  const navigate = useNavigate();
  const fromUrl = new URLSearchParams(location.search).get("variant");
  const [stored, setStored] = useState("A");
  useEffect(() => {
    try { setStored(localStorage.getItem("prototype-feed-variant") ?? "A"); } catch {}
  }, []);
  const variant = fromUrl ?? stored;
  const set = (v: string) => {
    try { localStorage.setItem("prototype-feed-variant", v); } catch {}
    setStored(v);
    const p = new URLSearchParams(location.search);
    p.set("variant", v);
    navigate({ search: p.toString() }, { replace: true, preventScrollReset: true });
  };
  return [variant, set] as const;
}

export function NotificationFeedPrototype({
  config,
  children,
}: {
  config: FeedConfig | null;
  children: (slots: { headerSlot: React.ReactNode; navSlot: React.ReactNode }) => React.ReactNode;
}) {
  const feed = useKnockFeed(config);
  const [variant, setVariant] = useVariant();
  const [drawerOpen, setDrawerOpen] = useState(false);
  useArrivalToasts(feed, variant === "C");

  const slots = !config
    ? { headerSlot: null, navSlot: null }
    : {
        headerSlot: variant === "A" ? <VariantA_Bell feed={feed} /> : null,
        navSlot:
          variant === "B" ? <VariantB_NavItem feed={feed} onOpen={() => setDrawerOpen(true)} /> :
          variant === "C" ? <VariantC_NavItem feed={feed} /> : null,
      };

  return (
    <FeedContext.Provider value={config ? feed : null}>
      {children(slots)}
      {config && variant === "B" && <VariantB_Drawer feed={feed} open={drawerOpen} onClose={() => setDrawerOpen(false)} />}
      <PrototypeSwitcher current={variant} onChange={setVariant} feed={config ? feed : null} />
    </FeedContext.Provider>
  );
}

function PrototypeSwitcher({ current, onChange, feed }: { current: string; onChange: (v: string) => void; feed: Feed | null }) {
  const i = Math.max(0, VARIANTS.findIndex((v) => v.key === current));
  const go = (d: number) => onChange(VARIANTS[(i + d + VARIANTS.length) % VARIANTS.length].key);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (ev.key === "ArrowLeft") go(-1);
      if (ev.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (import.meta.env.PROD) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-full bg-zinc-900 px-3 py-1.5 text-sm text-white shadow-2xl ring-2 ring-amber-400">
      <button onClick={() => go(-1)} className="rounded-full p-1 hover:bg-white/10"><ChevronLeft className="size-4" /></button>
      <span className="font-mono">
        {VARIANTS[i].key} <span className="text-white/60">({VARIANTS[i].name})</span>
      </span>
      <button onClick={() => go(1)} className="rounded-full p-1 hover:bg-white/10"><ChevronRight className="size-4" /></button>
      {feed && (
        <span className="border-l border-white/20 pl-3 font-mono text-xs text-white/60">
          unseen {feed.unseen} · unread {feed.unread} · total {feed.entries.length}
        </span>
      )}
      {feed && <SeedButton className="[&_button]:text-amber-300" />}
    </div>
  );
}
