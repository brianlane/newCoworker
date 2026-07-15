import { SidebarCustomizer } from "@/components/dashboard/SidebarCustomizer";
import { getSidebarLayout } from "@/lib/dashboard/sidebar-prefs";
import { filterSidebarItemsForBusiness } from "@/lib/dashboard/sidebar-items";
import { getPublicMetaConnection } from "@/lib/db/meta-connections";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function SidebarSettingsPage() {
  const { user, business } = await loadSettingsContext();

  // Same conditional-item filter as the dashboard layout: a business
  // without an active Meta connection never sees the Messenger entry,
  // in the nav or in this editor.
  let metaConnected = false;
  if (business?.id) {
    const metaConnection = await getPublicMetaConnection(business.id).catch(() => null);
    metaConnected =
      metaConnection?.status === "active" && metaConnection.is_active === true;
  }
  const layout = filterSidebarItemsForBusiness(await getSidebarLayout(user.userId), {
    metaConnected
  });

  return (
    <SettingsPageShell
      title="Sidebar"
      blurb="Reorder the navigation and hide pages you don't use"
    >
      <SidebarCustomizer initialLayout={layout} />
    </SettingsPageShell>
  );
}
