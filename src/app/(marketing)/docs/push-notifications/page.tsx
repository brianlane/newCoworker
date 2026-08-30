import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

/**
 * How an owner turns on push alerts, screenshot by screenshot.
 *
 * English only, the same call /docs/api makes: the substance is the literal
 * wording of iOS and browser controls ("Add to Home Screen", "Open as Web
 * App", "Allow"), which Apple localizes on the device anyway, so a translated
 * page would name buttons the reader cannot find.
 *
 * The iPhone half is the reason this page exists. iOS delivers Web Push ONLY
 * to a web app installed on the Home Screen, and Apple offers no install
 * prompt a site can trigger, so the install is a manual sequence the owner has
 * to be walked through. The step every owner gets wrong is the last one:
 * installing, then returning to the Safari tab to turn alerts on, where the
 * button cannot work. Step 5 says so in as many words.
 *
 * Screenshots live in public/docs/push and were taken on a real iPhone. Keep
 * them in step with PushSetupCard, whose copy this page quotes.
 */

export const metadata: Metadata = {
  title: "Push Notifications on Your Phone",
  description:
    "Install New Coworker on your iPhone, iPad, Android phone, or desktop and get urgent alerts the moment they happen, even when the app is closed.",
  alternates: { canonical: "/docs/push-notifications" }
};

const STEPS = [
  {
    id: "step-1",
    n: 1,
    title: "Open your dashboard in Safari",
    image: "/docs/push/01-safari-dashboard.webp",
    width: 680,
    height: 804,
    alt: "The New Coworker dashboard open in Safari on an iPhone.",
    body: (
      <>
        <p>
          Go to <strong className="text-parchment/90">newcoworker.com</strong> in Safari and sign in.
          You should be looking at your dashboard.
        </p>
        <p>
          It has to be Safari. iPhone and iPad can only install a web app from Safari, so Chrome,
          Firefox, and the built-in browsers inside apps like Instagram or Gmail will not offer the
          step you need next.
        </p>
      </>
    )
  },
  {
    id: "step-2",
    n: 2,
    title: "Open the Share menu",
    image: "/docs/push/02-safari-menu.webp",
    width: 680,
    height: 756,
    alt: "Safari's menu open, with Share at the top of the list.",
    body: (
      <>
        <p>
          Tap the <strong className="text-parchment/90">...</strong> button in the bar at the bottom
          of Safari, then choose <strong className="text-parchment/90">Share</strong>.
        </p>
        <p>
          On some iOS versions the share icon (a square with an arrow pointing up) sits directly in
          the bottom bar instead. Either route opens the same sheet.
        </p>
      </>
    )
  },
  {
    id: "step-3",
    n: 3,
    title: "Choose Add to Home Screen",
    image: "/docs/push/03-share-sheet.webp",
    width: 680,
    height: 974,
    alt: "The iOS share sheet scrolled down to the Add to Home Screen row.",
    body: (
      <>
        <p>
          Scroll down the share sheet. Past Add to Reading List, Add to Favorites, and Find on Page
          you will find <strong className="text-parchment/90">Add to Home Screen</strong>.
        </p>
        <p>
          It is usually near the bottom of the list, so keep scrolling if you do not see it at first.
        </p>
      </>
    )
  },
  {
    id: "step-4",
    n: 4,
    title: "Confirm the name and tap Add",
    image: "/docs/push/04-name-and-add.webp",
    width: 680,
    height: 644,
    alt: "The Add to Home Screen dialog showing the name New Coworker and the Open as Web App switch turned on.",
    body: (
      <>
        <p>
          The name should already read <strong className="text-parchment/90">New Coworker</strong>.
          You can change it to anything you like.
        </p>
        <p>
          Leave <strong className="text-parchment/90">Open as Web App</strong> switched on. That
          switch is what makes this a real app instead of a bookmark, and alerts do not work without
          it.
        </p>
        <p>
          Tap <strong className="text-parchment/90">Add</strong>. The icon appears on your Home
          Screen.
        </p>
      </>
    )
  },
  {
    id: "step-5",
    n: 5,
    title: "Open the app and tap Turn on alerts",
    image: "/docs/push/05-turn-on-alerts.webp",
    width: 680,
    height: 489,
    alt: "The installed app showing a banner that reads Get urgent alerts on this device, with Turn on alerts and Not now buttons.",
    body: (
      <>
        <p>
          Open <strong className="text-parchment/90">New Coworker</strong> from your Home Screen, not
          from Safari. A banner at the top reads{" "}
          <em className="text-parchment/80">Get urgent alerts on this device</em>. Tap{" "}
          <strong className="text-parchment/90">Turn on alerts</strong>.
        </p>
        <p className="rounded-xl border border-spark-orange/25 bg-spark-orange/5 px-4 py-3 text-sm">
          <strong className="text-parchment/90">This is the step people get wrong.</strong> If you
          install the app and then go back to your old Safari tab to turn alerts on, nothing will
          happen. iPhone only allows alerts inside the installed app, so the button has to be tapped
          there.
        </p>
        <p>
          The banner shows once. If you tap <strong className="text-parchment/90">Not now</strong> it
          stops asking, and you can still turn alerts on any time from{" "}
          <strong className="text-parchment/90">Notifications</strong> in the dashboard menu.
        </p>
      </>
    )
  },
  {
    id: "step-6",
    n: 6,
    title: "Tap Allow",
    image: "/docs/push/06-allow.webp",
    width: 680,
    height: 850,
    alt: "The iOS system prompt asking whether New Coworker may send notifications, with Don't Allow and Allow buttons.",
    body: (
      <>
        <p>
          iPhone asks for permission once. Tap <strong className="text-parchment/90">Allow</strong>.
        </p>
        <p>
          If you tap Don&apos;t Allow, iPhone will not ask again. To undo it, open the iPhone{" "}
          <strong className="text-parchment/90">Settings</strong> app, find New Coworker in the app
          list, and turn Notifications back on there.
        </p>
      </>
    )
  },
  {
    id: "step-7",
    n: 7,
    title: "That is it. Alerts arrive",
    image: "/docs/push/07-lock-screen.webp",
    width: 680,
    height: 1477,
    alt: "An iPhone lock screen showing a New Coworker push notification.",
    body: (
      <>
        <p>
          Urgent alerts now land on your lock screen the moment they happen, whether or not the app
          is open and whether or not your phone has signal for text messages.
        </p>
        <p>
          Tapping an alert opens the app on the thing that happened, so a missed call opens that
          call and a new lead opens that lead. You do not have to go hunting for it.
        </p>
      </>
    )
  }
] as const;

const TOC = [
  ["what-it-is", "What this gets you"],
  ["iphone", "Install on iPhone or iPad"],
  ["android", "Android, Mac, and Windows"],
  ["settings", "Choosing what arrives"],
  ["per-device", "Push is per device"],
  ["troubleshooting", "If alerts are not arriving"],
  ["privacy", "What appears on the lock screen"]
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 space-y-3">
      <h2 className="text-2xl font-semibold tracking-tight text-parchment">{title}</h2>
      <div className="space-y-3 text-parchment/75">{children}</div>
    </section>
  );
}

function Step({ step }: { step: (typeof STEPS)[number] }) {
  return (
    <div
      id={step.id}
      className="scroll-mt-24 grid gap-6 border-t border-parchment/10 pt-10 sm:grid-cols-[1fr_15rem] sm:gap-10"
    >
      <div className="space-y-3 text-parchment/75">
        <div className="flex items-center gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-claw-green/15 font-mono text-sm font-semibold text-claw-green">
            {step.n}
          </span>
          <h3 className="text-lg font-semibold text-parchment">{step.title}</h3>
        </div>
        <div className="space-y-3 text-sm leading-relaxed sm:text-base">{step.body}</div>
      </div>
      <div className="justify-self-center sm:justify-self-end">
        <Image
          src={step.image}
          alt={step.alt}
          width={step.width}
          height={step.height}
          sizes="(min-width: 640px) 15rem, 60vw"
          className="w-44 rounded-2xl border border-parchment/15 shadow-lg shadow-black/40 sm:w-60"
        />
      </div>
    </div>
  );
}

export default function PushNotificationsGuidePage() {
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />
      <main className="mx-auto max-w-4xl px-6 pb-24 pt-6">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-signal-teal">Guides</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
          Push notifications on your phone
        </h1>
        <p className="mt-5 text-base leading-7 text-parchment/70 sm:text-lg">
          New Coworker installs onto your phone like an app, and once it is there your coworker can
          reach you the way every other app does: a banner on your lock screen, the moment something
          urgent happens. No app store, no download, about a minute of setup.
        </p>

        <nav
          aria-label="On this page"
          className="mt-8 rounded-2xl border border-parchment/10 bg-parchment/[0.03] p-5"
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-parchment/45">
            On this page
          </p>
          <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="text-parchment/70 hover:text-claw-green">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-14 space-y-14">
          <Section id="what-it-is" title="What this gets you">
            <p>
              Your coworker already tells you about urgent things by text, email, and the dashboard.
              Push adds a fourth way, and it is the fastest one: it arrives instantly, it costs
              nothing per message, and it works over wifi when your phone has no bars.
            </p>
            <p>
              It is also the only channel that can tell whether you actually saw an alert. A delivered
              text proves a handset received something. A tapped notification proves a person opened
              it. That is what lets your coworker notice when a way of reaching you has quietly
              stopped working, and start using a different one.
            </p>
            <p className="rounded-xl border border-parchment/10 bg-parchment/[0.03] px-4 py-3 text-sm">
              Push notifications are included on the{" "}
              <Link href="/pricing" className="text-claw-green hover:underline">
                Standard and Enterprise plans
              </Link>
              .
            </p>
          </Section>

          <Section id="iphone" title="Install on iPhone or iPad">
            <p>
              iPhone and iPad only deliver alerts to a web app that lives on the Home Screen, so
              there are two parts to this: install the app, then turn alerts on inside it. Takes
              about a minute. You need iOS 16.4 or later, which covers an iPhone 8 or newer that has
              been kept up to date.
            </p>
            <div className="space-y-10 pt-4">
              {STEPS.map((step) => (
                <Step key={step.id} step={step} />
              ))}
            </div>
          </Section>

          <Section id="android" title="Android, Mac, and Windows">
            <p>
              Everywhere else this is shorter, because only Apple requires the Home Screen install
              first.
            </p>
            <p>
              <strong className="text-parchment/90">Android:</strong> open your dashboard in Chrome,
              go to <strong className="text-parchment/90">Notifications</strong> in the menu, and tap
              <strong className="text-parchment/90"> Turn on alerts</strong> under &ldquo;Alerts on
              this device&rdquo;. Chrome can also install New Coworker to your home screen from its
              own menu, which is worth doing, but alerts work either way.
            </p>
            <p>
              <strong className="text-parchment/90">Mac and Windows:</strong> same thing in Chrome,
              Edge, Firefox, or Safari, with no install step at all. Alerts appear in the operating
              system&apos;s own notification centre while the browser is running, even when the New
              Coworker tab is closed.
            </p>
          </Section>

          <Section id="settings" title="Choosing what arrives">
            <p>
              Everything lives under <strong className="text-parchment/90">Notifications</strong> in
              the dashboard menu.
            </p>
            <p>
              <strong className="text-parchment/90">Push: urgent alerts</strong> turns pushes on and
              off across all your devices at once. Turning it off here stops them everywhere without
              having to uninstall anything.
            </p>
            <p>
              <strong className="text-parchment/90">Push instead of text</strong> sends the alert to
              your phone as a notification and skips the text message, so one urgent thing does not
              buzz your phone twice. It switches itself on if we can see you reading pushes and
              ignoring texts, and once you touch the switch yourself it stays exactly where you put
              it.
            </p>
            <p>
              The per-event choices above these switches (new lead, missed call, booking, and so on)
              apply to push the same as to every other channel.
            </p>
          </Section>

          <Section id="per-device" title="Push is per device">
            <p>
              Turning alerts on is a decision each device makes for itself, not something stored on
              your account. Install it on your phone and your laptop and you have to tap{" "}
              <strong className="text-parchment/90">Turn on alerts</strong> once on each. That is the
              browser&apos;s rule, not ours, and it is the same reason no website can start sending
              you notifications without asking.
            </p>
            <p>
              It also means you can stop alerts on one device without touching the others. Open{" "}
              <strong className="text-parchment/90">Notifications</strong> on that device and tap{" "}
              <strong className="text-parchment/90">Turn off on this device</strong>. Deleting the
              app from your Home Screen has the same effect.
            </p>
            <p>
              Teammates get their own. Everyone on your team can install it and turn on alerts for
              the events they are meant to see.
            </p>
          </Section>

          <Section id="troubleshooting" title="If alerts are not arriving">
            <p>
              <strong className="text-parchment/90">
                The button does nothing, or there is no button.
              </strong>{" "}
              On iPhone this almost always means you are in a Safari tab rather than the installed
              app. Close Safari, open New Coworker from your Home Screen, and try again there.
            </p>
            <p>
              <strong className="text-parchment/90">
                You are in an app&apos;s built-in browser.
              </strong>{" "}
              Links opened from Instagram, Facebook, Gmail, or a messaging app run in a stripped-down
              browser that cannot install anything or receive alerts. Open the page in Safari or
              Chrome instead.
            </p>
            <p>
              <strong className="text-parchment/90">You tapped Don&apos;t Allow.</strong> A browser
              only asks once. On iPhone, turn Notifications back on for New Coworker in the
              Settings app. On desktop, click the padlock or icon at the left of the address bar and
              allow notifications for the site, then reload.
            </p>
            <p>
              <strong className="text-parchment/90">Focus, Do Not Disturb, or a sleep schedule.</strong>{" "}
              These silence New Coworker along with everything else. If urgent alerts must always
              break through, add New Coworker to the allowed apps for that Focus in your phone&apos;s
              settings.
            </p>
            <p>
              <strong className="text-parchment/90">It worked and then stopped.</strong> Deleting the
              Home Screen icon, clearing website data, or a long stretch without opening the app can
              all end a device&apos;s subscription. Open the app and turn alerts on again. Nothing
              else is lost.
            </p>
          </Section>

          <Section id="privacy" title="What appears on the lock screen">
            <p>
              By default an alert shows what happened in full, because an alert you have to unlock
              your phone to understand is not much of an alert.
            </p>
            <p>
              Businesses that have turned on our HIPAA handling get content-free alerts instead: the
              notification tells you there is something to look at and nothing else, and the details
              only appear once you open the app and are signed in. No customer name, number, or
              message content reaches the lock screen.
            </p>
            <p>
              Either way the alert is encrypted end to end between us and your device. Apple, Google,
              and Mozilla pass the message along without being able to read it.
            </p>
          </Section>
        </div>

        <div className="mt-16 rounded-2xl border border-parchment/10 bg-parchment/[0.03] p-6">
          <h2 className="text-lg font-semibold text-parchment">Still stuck</h2>
          <p className="mt-2 text-sm text-parchment/70">
            Tell us what you are seeing from the{" "}
            <Link href="/contact" className="text-claw-green hover:underline">
              contact page
            </Link>{" "}
            and say which phone and browser you are on. If push will not work on your device, urgent
            alerts keep arriving by text and email exactly as before.
          </p>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
