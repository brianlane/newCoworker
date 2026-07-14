export const BUSINESS_TYPE_LABELS = {
  real_estate: "Real Estate",
  hair_salons: "Hair Salons",
  massage_therapy: "Massage Therapy",
  pet_services: "Pet Services",
  auto_repair: "Auto Repair",
  hvac_services: "HVAC Services",
  plumbing: "Plumbing",
  landscaping: "Landscaping",
  pool_services: "Pool Services",
  cleaning_services: "Cleaning Services",
  personal_training: "Personal Training",
  photography: "Photography",
  web_design: "Web Design",
  consulting: "Consulting",
  accounting: "Accounting",
  legal_services: "Legal Services",
  dental_care: "Dental Care",
  chiropractic: "Chiropractic",
  medical_practice: "Medical Practice",
  physical_therapy: "Physical Therapy",
  med_spa: "Med Spa",
  veterinary: "Veterinary",
  handyman_service: "Handyman Service",
  painting: "Painting",
  roofing: "Roofing",
  pest_control: "Pest Control",
  solar_services: "Solar Services",
  garage_door_services: "Garage Door Services",
  beauty_spa: "Beauty Spa",
  wellness_services: "Wellness Services",
  event_planning: "Event Planning",
  general_contractors: "General Contractors",
  electrical_contractors: "Electrical Contractors",
  custom_carpentry: "Custom Carpentry",
  appliance_repair: "Appliance Repair",
  catering: "Catering",
  it_support: "IT Support",
  tutoring: "Tutoring",
  carpet_cleaning: "Carpet Cleaning",
  moving_services: "Moving Services",
  dj_services: "DJ Services",
  tax_preparation: "Tax Preparation",
  insurance_agency: "Insurance Agency",
  mortgage_brokerage: "Mortgage Brokerage",
  yoga_classes: "Yoga Classes",
  escape_rooms: "Escape Rooms",
  wine_tasting: "Wine Tasting",
  cooking_classes: "Cooking Classes",
  art_studios: "Art Studios",
  dance_studios: "Dance Studios",
  music_lessons: "Music Lessons",
  adventure_tours: "Adventure Tours",
  boat_charters: "Boat Charters",
  food_tours: "Food Tours",
  museums: "Museums",
  aquariums: "Aquariums",
  theme_parks: "Theme Parks",
  zip_lines: "Zip Lines",
  paintball: "Paintball",
  bowling_alleys: "Bowling Alleys",
  mini_golf: "Mini Golf",
  arcades: "Arcades",
  workshops: "Workshops",
  retreats: "Retreats",
  equipment_rentals: "Equipment Rentals",
  party_rentals: "Party Rentals",
  event_rentals: "Event Rentals",
  photo_booth_rentals: "Photo Booth Rentals",
  bike_rentals: "Bike Rentals",
  kayak_rentals: "Kayak Rentals",
  camping_gear_rentals: "Camping Gear Rentals",
  bounce_house_rentals: "Bounce House Rentals",
  boat_rentals: "Boat Rentals",
  ghost_tours: "Ghost Tours",
  laser_tag: "Laser Tag",
  comedy_clubs: "Comedy Clubs",
  festivals: "Festivals",
  farmers_markets: "Farmers Markets",
  boutiques: "Boutiques",
  jewelry_stores: "Jewelry Stores",
  electronics: "Electronics",
  bookstores: "Bookstores",
  art_galleries: "Art Galleries",
  craft_stores: "Craft Stores",
  antique_shops: "Antique Shops",
  toy_stores: "Toy Stores",
  sports_equipment: "Sports Equipment",
  outdoor_gear: "Outdoor Gear",
  home_decor: "Home Decor",
  furniture_stores: "Furniture Stores",
  bakeries: "Bakeries",
  coffee_shops: "Coffee Shops",
  wine_shops: "Wine Shops",
  specialty_foods: "Specialty Foods",
  cosmetics: "Cosmetics",
  pet_supplies: "Pet Supplies",
  plant_nurseries: "Plant Nurseries",
  hardware_stores: "Hardware Stores",
  gift_shops: "Gift Shops",
  clothing: "Clothing",
  local_artisans: "Local Artisans",
  tool_rental: "Tool Rental",
  construction_equipment: "Construction Equipment",
  medical_equipment_rentals: "Medical Equipment Rentals",
  audiovisual_rentals: "Audiovisual Rentals",
  costume_rentals: "Costume Rentals",
  furniture_rentals: "Furniture Rentals",
  sports_equipment_rentals: "Sports Equipment Rentals",
  other: "Other"
} as const;

export type BusinessType = keyof typeof BUSINESS_TYPE_LABELS;

export const DEFAULT_BUSINESS_TYPE: BusinessType = "real_estate";

export const BUSINESS_TYPE_OPTIONS = Object.entries(BUSINESS_TYPE_LABELS).map(([value, label]) => ({
  value: value as BusinessType,
  label:
    // The bare label "Other" undersells that picking it reveals a text
    // input; mirror CRM_OPTIONS' phrasing so users know they can type
    // their own industry.
    value === "other" ? "Other (I'll type it in)" : label
}));

export const BUSINESS_TYPE_OTHER_VALUE: BusinessType = "other";

/**
 * Render the stored business-type string as a (selection, free-text)
 * pair the form UI can display. Round-trips with
 * `serializeBusinessTypeSelection`. Mirrors `deriveCrmSelection` in
 * `intakeOptions.ts`, except custom values are stored RAW (no
 * "Other: " prefix) so downstream consumers (`identity.md`,
 * `businessTypeLabel`) render the user's own words directly.
 *
 *   ""                  → { selection: "",           otherText: "" }
 *   "consulting"        → { selection: "consulting", otherText: "" }
 *   "other"             → { selection: "other",      otherText: "" }
 *   "Drone Photography" → { selection: "other",      otherText: "Drone Photography" }
 *
 * The bare `"other"` value doubles as the in-flight sentinel: it keeps
 * the dropdown in its Other state (revealing the text input) while the
 * user hasn't typed anything yet, and is recognized by
 * `isBusinessTypeSelectionComplete` as an incomplete answer.
 */
export function deriveBusinessTypeSelection(stored: string | undefined | null): {
  selection: string;
  otherText: string;
} {
  const value = (stored ?? "").trim();
  if (!value) return { selection: "", otherText: "" };
  if (value === BUSINESS_TYPE_OTHER_VALUE) {
    return { selection: BUSINESS_TYPE_OTHER_VALUE, otherText: "" };
  }
  if (value in BUSINESS_TYPE_LABELS) return { selection: value, otherText: "" };
  // Unknown free-text value (custom industry, legacy draft, etc.) →
  // bucket as Other so the user sees and can edit what they entered.
  return { selection: BUSINESS_TYPE_OTHER_VALUE, otherText: value };
}

/**
 * Inverse of `deriveBusinessTypeSelection`. Other with empty text
 * serializes to the bare `"other"` slug (rather than `""`) so the
 * dropdown can re-render in its Other state and keep the custom-text
 * input visible. Use `isBusinessTypeSelectionComplete` (not a raw
 * truthiness check) for advance-gate validation, since `"other"` is
 * intentionally truthy-but-incomplete.
 */
export function serializeBusinessTypeSelection(selection: string, otherText: string): string {
  if (!selection) return "";
  if (selection === BUSINESS_TYPE_OTHER_VALUE) {
    const trimmed = otherText.trim();
    if (!trimmed) return BUSINESS_TYPE_OTHER_VALUE;
    // Custom text of exactly "other" would collide with the bare
    // in-flight sentinel: it would derive back to empty text (wiping the
    // input) and keep the advance gate closed even though the user typed
    // an answer. Store the display-cased label instead — "Other" is not a
    // slug, so it round-trips as custom text.
    if (trimmed === BUSINESS_TYPE_OTHER_VALUE) return BUSINESS_TYPE_LABELS.other;
    return trimmed;
  }
  return selection;
}

/**
 * True when the stored business-type value represents a completed
 * answer: any known slug (except bare `"other"`) or any non-empty
 * custom text. Empty string and the in-flight bare `"other"` block
 * Step 1 advance.
 */
export function isBusinessTypeSelectionComplete(stored: string | undefined | null): boolean {
  const value = (stored ?? "").trim();
  if (!value) return false;
  if (value === BUSINESS_TYPE_OTHER_VALUE) return false;
  return true;
}
