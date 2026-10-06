/* ============================================================
   GC Redemption Portal — configuration
   ------------------------------------------------------------
   1. Deploy gc-portal-backend/Code.gs as a Google Apps Script
      Web App (see README.md).
   2. Paste the Web App URL (ends in /exec) into API_URL below.
   While API_URL is empty the app runs in DEMO MODE: data is kept
   on this device only and NO email is sent.
   ============================================================ */
window.GC_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbzJT985gHRjzeD70uWmNEalbzvJsCHHheKAPQY1oRq8KS8hXeheORrNrsQa2jBlnzbR/exec',

  APP_NAME: 'GC Submissions',
  COMPANY: "Toby's Sports",
  EMAIL_TO: 'FranchiseDev@tobys.com',

  /* Franchise Development only — "Open Monitoring Sheet" button in the sidebar.
     The password is stored as a SHA-256 hash (current password: ask FD). */
  MONITORING_SHEET_URL: 'https://docs.google.com/spreadsheets/d/1SsksC95QnqGBFnPZpXgj98CKsKk-7sfTeg-omrY24Fw/edit?gid=1165688870#gid=1165688870',
  MONITORING_PASS_SHA256: 'acb9f26c5ece8d434d16841b363be97592ed09ecae632a8ad5c70025863f95fa',

  GC_TYPES: [
    { id: 'TOBYS GC',      label: 'TOBYS GC',      hint: "Toby's Sports gift certificate" },
    { id: 'Sodexo Pluxee', label: 'Sodexo Pluxee', hint: 'Pluxee (formerly Sodexo) GC' }
  ],

  MAX_IMAGES: 10,          // per submission
  MAX_SERIES: 500,         // per submission
  IMAGE_MAX_PX: 1600,      // photos are resized to this longest side
  IMAGE_QUALITY: 0.78,     // JPEG quality after resize

  /* Used only in demo mode or if the store list can't be loaded.
     The live list comes from the "Stores" tab of the Google Sheet. */
  FALLBACK_STORES: [
    { code: 'AURA',    name: 'SM Aura Premier',       area: 'Central', hasPin: false },
    { code: 'RME',     name: 'Robinsons Metro East',  area: 'Central', hasPin: false },
    { code: 'GH',      name: 'Greenhills',            area: 'Central', hasPin: false },
    { code: 'TAYTAY',  name: 'SM Taytay',             area: 'North',   hasPin: false },
    { code: 'SEASIDE', name: 'SM Seaside Cebu',       area: 'South',   hasPin: false }
  ]
};
