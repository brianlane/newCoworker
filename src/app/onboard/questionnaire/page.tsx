import QuestionnaireClient from "./QuestionnaireClient";
import { listMembershipPackAddonOptions } from "@/lib/billing/membership-pack-addons";

export default function QuestionnairePage() {
  const packAddonOptions = listMembershipPackAddonOptions();
  return <QuestionnaireClient packAddonOptions={packAddonOptions} />;
}
