import { getTranslations } from "next-intl/server";
import { BusinessBasicsForms } from "@/components/dashboard/BusinessBasicsForms";
import { BusinessProfileForm } from "@/components/dashboard/BusinessProfileForm";
import { OwnerProfileForm } from "@/components/dashboard/OwnerProfileForm";
import { ServicesManager } from "@/components/dashboard/ServicesManager";
import { parseBusinessHours } from "@/lib/business-profile/profile";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function BusinessSettingsPage() {
  const t = await getTranslations("dashboard.settings");
  const { business, isOwner } = await loadSettingsContext();

  return (
    <SettingsPageShell
      title={t("hubBusinessTitle")}
      blurb={t("businessPageBlurb")}
    >
      <BusinessBasicsForms
        businessName={business?.name ?? ""}
        businessTimezone={business?.timezone ?? null}
      />

      {business && isOwner && (
        <OwnerProfileForm
          initialOwnerName={business.owner_name ?? null}
          initialPhone={business.phone ?? null}
        />
      )}

      {business && (
        <BusinessProfileForm
          initialAddress={business.address ?? null}
          initialBusinessType={business.business_type ?? null}
          initialHours={parseBusinessHours(business.business_hours ?? null)}
        />
      )}

      {business && <ServicesManager />}
    </SettingsPageShell>
  );
}
