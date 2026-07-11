import { BusinessBasicsForms } from "@/components/dashboard/BusinessBasicsForms";
import { BusinessProfileForm } from "@/components/dashboard/BusinessProfileForm";
import { OwnerProfileForm } from "@/components/dashboard/OwnerProfileForm";
import { ServicesManager } from "@/components/dashboard/ServicesManager";
import { parseBusinessHours } from "@/lib/business-profile/profile";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function BusinessSettingsPage() {
  const { business, isOwner } = await loadSettingsContext();

  return (
    <SettingsPageShell
      title="Business"
      blurb="Who you are — your coworker answers customer questions from these facts"
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
