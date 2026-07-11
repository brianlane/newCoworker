import { SidebarCustomizer } from "@/components/dashboard/SidebarCustomizer";
import { getSidebarLayout } from "@/lib/dashboard/sidebar-prefs";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function SidebarSettingsPage() {
  const { user } = await loadSettingsContext();

  return (
    <SettingsPageShell
      title="Sidebar"
      blurb="Reorder the navigation and hide pages you don't use"
    >
      <SidebarCustomizer initialLayout={await getSidebarLayout(user.userId)} />
    </SettingsPageShell>
  );
}
