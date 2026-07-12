"use client";

/**
 * Website SEO insights card for /dashboard/memory (next to Website
 * Knowledge — it audits the same site).
 *
 * Runs the on-demand audit (POST /api/dashboard/seo/analyze), then shows
 * the overall score, the weakest factors, and prioritized suggestions.
 * Honest copy: heuristic on-page/local signals — not live Google rankings.
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export type SeoReportView = {
  url: string;
  analyzedAt: string;
  overall: number;
  breakdown: Record<string, number>;
  suggestions: string[];
  aiRecommendations: string[];
};

type Props = {
  businessId: string;
  websiteUrl: string | null;
  initialReport: SeoReportView | null;
};

const FACTOR_LABELS: Record<string, string> = {
  title: "Page title",
  description: "Meta description",
  content: "Content depth",
  localSeo: "Local signals",
  technical: "Technical",
  images: "Image alt text",
  linking: "Internal links",
  mobile: "Mobile-ready"
};

function scoreTone(score: number): string {
  return score >= 80 ? "text-claw-green" : score >= 50 ? "text-amber-300" : "text-red-300";
}

export function SeoInsightsCard({ businessId, websiteUrl, initialReport }: Props) {
  const [report, setReport] = useState<SeoReportView | null>(initialReport);
  const [running, setRunning] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  // Derived-state reset (React's sanctioned render-time pattern): when the
  // owner saves a different website URL and the server re-renders this card
  // with new props, drop the state captured for the OLD site — otherwise
  // useState would keep showing the previous hostname's scores until a full
  // remount.
  const [seenWebsiteUrl, setSeenWebsiteUrl] = useState(websiteUrl);
  if (seenWebsiteUrl !== websiteUrl) {
    setSeenWebsiteUrl(websiteUrl);
    setReport(initialReport);
    setBanner(null);
  }

  async function analyze() {
    setBanner(null);
    setRunning(true);
    try {
      const res = await fetch("/api/dashboard/seo/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = (await res.json()) as {
        data?: { report?: SeoReportView };
        error?: { message?: string };
      };
      if (!res.ok) {
        setBanner(json.error?.message ?? "The audit failed — try again in a minute.");
        return;
      }
      setReport(json.data?.report ?? null);
    } finally {
      setRunning(false);
    }
  }

  const weakest = report
    ? Object.entries(report.breakdown)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 3)
    : [];

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-parchment">Website SEO insights</h3>
          <p className="text-xs text-parchment/50 mt-1">
            A quick on-page and local-SEO audit of your website. Heuristic checks — it does
            not read live Google rankings.
          </p>
        </div>
        {report ? (
          <span className={`text-2xl font-bold ${scoreTone(report.overall)}`}>
            {report.overall}
            <span className="text-xs font-normal text-parchment/40">/100</span>
          </span>
        ) : null}
      </div>

      {banner ? <p className="text-xs text-spark-orange mt-3">{banner}</p> : null}

      {report ? (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {weakest.map(([factor, score]) => (
              <span key={factor} className="text-xs text-parchment/60">
                {FACTOR_LABELS[factor] ?? factor}:{" "}
                <span className={scoreTone(score)}>{Math.round(score)}</span>
              </span>
            ))}
          </div>
          {(report.aiRecommendations.length > 0
            ? report.aiRecommendations
            : report.suggestions
          )
            .slice(0, 5)
            .map((s, i) => (
              <p key={i} className="text-sm text-parchment/75">
                • {s}
              </p>
            ))}
          <p className="text-[10px] text-parchment/35">
            Audited {report.url} ·{" "}
            {new Date(report.analyzedAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric"
            })}
          </p>
        </div>
      ) : (
        <p className="text-xs text-parchment/40 mt-3">
          {websiteUrl
            ? "Run your first audit to see where your site stands."
            : "Set your website under Website Knowledge first."}
        </p>
      )}

      <div className="mt-4">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={running}
          disabled={!websiteUrl}
          onClick={() => void analyze()}
        >
          {report ? "Re-run audit" : "Run audit"}
        </Button>
      </div>
    </Card>
  );
}
