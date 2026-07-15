// schema.js
// Field definitions matching the eCAT Material Archive form.
// "scrapeableFields" are ones we ask Claude to try to extract from a
// supplier page. "manualOnlyFields" are internal/relationship data
// that rarely exists on a public site -- left null for manual entry later.

module.exports = {
  scrapeableFields: {
    productName: "The product's display name",
    category: "Material category, e.g. Carpet, Tile, Vinyl, Wallcovering, Laminate",
    productCode: "Product code, SKU, or pattern name/number",
    dimensions: "Physical size, e.g. '50cm x 50cm' or '600 x 600mm'",
    materialComposition: "What the material is made of, e.g. '100% Nylon'",
    weightThickness: "Weight or thickness spec, e.g. '5.6mm' or '450g/sqm'",
    fireRating: "Fire rating classification, e.g. 'Class 1', 'B1'",
    moistureResistance: "Moisture/water resistance rating, e.g. 'IP54'",
    acousticRating: "Acoustic rating, e.g. 'NRC 0.15'",
    unitOfMeasurement: "Unit the product is sold/measured in, e.g. 'per sqm', 'per box'",
    greenCertification: "Environmental certification body/label, e.g. 'SGBC', 'GREENGUARD'",
    vocEmissionTest: "VOC emission test result if published",
    otherCertificates: "Any other named certifications",
    unitPrice: "Numeric unit price, only if explicitly published on the page",
    currency: "Currency code for the price, e.g. SGD, USD",
    countryOfOrigin: "Country of manufacture/origin",
    sampleAvailable: "true/false/null -- whether the site mentions samples are available",
    sampleNotes: "Any notes about sample size/format",
    brochureUrl: "Link to a brochure/catalog PDF or page",
    datasheetUrl: "Link to a technical datasheet PDF",
    installationGuideUrl: "Link to installation instructions",
    maintenanceGuideUrl: "Link to maintenance/care instructions",
    certificatesUrl: "Link to a certificates page/PDF",
    colourVariants: "Array of {colourName, productCode} for each colour/finish variant shown on the page",
  },
  manualOnlyFields: [
    "supplierCompanyName",
    "manufacturer",
    "contactPerson",
    "contactNumber",
    "contactEmail",
    "pricingTier",
    "moq",
    "warranty",
    "standardLeadTime",
    "remarksUsage",
    "sustainabilityRemarks",
    "cadBimFiles",
    "procurementStatus",
  ],
};
