/**
 * PP Asset Service — Insurance Web App
 *
 * This file is the server code for a new Apps Script bound to
 * PP Asset Insurance Product Master.
 * The existing main site, lead project and loan Web App are intentionally
 * left unchanged.
 *
 * Customer-facing rules:
 * - This page is for motor insurance only.
 * - Province means the province where the vehicle is registered.
 * - Coverage type and sum insured come from the live master data.
 * - Type 1 is sent to an officer for a quotation; it is not priced here.
 * - Pickup-body additions show only "covered / not covered" for leaf springs
 *   and floating axles. Technical remarks are not shown to customers.
 */

var PP_INSURANCE_CONFIG = {
  MASTER_SPREADSHEET_ID: '1XiknAuU9jOuWA2OiA3hcbrCot3PlV6tM5M59S8cf_Gg',
  VEHICLE_SHEET: 'Vehicle_Master',
  PRICE_SHEET: 'DLT_Vehicle_Prices',
  MODIFICATION_SHEET: 'Vehicle_Modification_Rules',
  LOG_SHEET: 'Insurance_Web_Check',
  RATE_SHEET: 'Package_Rates',
  PRODUCT_SHEET: 'Product_Master',
  COMPANY_SHEET: 'Company_Index',
  PROVINCE_SHEET: 'Province_Criteria',
  AGE_SHEET: 'Age_Criteria',
  AUDIT_SHEET: 'Special_Coverage_Audit',
  COVERAGE_SHEET: 'Coverage_Detail',
  SPECIAL_MASTER_SHEETS: ['Special_Coverage_Master', 'Special_CoverAGE_MASTER'],
  MAX_RATES: 100,
  TYPE1_MAX_VEHICLE_AGE: 25
};

var PP_INSURANCE_COVERAGE_TYPES = [
  { value: '1', label: 'ประเภท 1', staffOnly: true },
  { value: '2+', label: 'ประเภท 2+' },
  { value: '3+', label: 'ประเภท 3+' },
  { value: '3', label: 'ประเภท 3' }
];

var PP_INSURANCE_USAGE_TYPES = [
  'ส่วนบุคคล',
  'รถพาณิชย์',
  'รถรับจ้างสาธารณะ/แท็กซี่',
  'App Car',
  'ขนส่งสินค้า',
  'ไม่แน่ใจ'
];

var PP_INSURANCE_MODIFICATIONS = [
  'ไม่มี',
  'คอก/แซง/รั้ว',
  'ตู้ทึบ',
  'ตู้แห้ง',
  'ไม่แน่ใจ'
];

/** Entry point for the new, stand-alone insurance Apps Script. */
function doGet(e) {
  // Opt-in TEST preview only. The default page remains unchanged.
  if (e && e.parameter && e.parameter.flow === 'quote-request-test') {
    return HtmlService.createHtmlOutputFromFile('IndexQuoteRequestTest').setTitle('TEST — คำขอเช็กเบี้ย | PP Asset Service').addMetaTag('viewport', 'width=device-width, initial-scale=1').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ประกันภัยรถยนต์ | PP Asset Service')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Return the values needed to render the form. */
function webGetInsuranceFormOptions() {
  var snapshot = insuranceLoadSnapshot_();
  var vehicles = snapshot.vehicles;
  var publicVehicles = vehicles.map(function (item) {
    return {
      vehicleId: item.vehicleId,
      category: item.category,
      make: item.make,
      model: item.model,
      submodel: item.submodel,
      yearMin: item.yearMin,
      yearMax: item.yearMax,
      vehicleGroup: item.vehicleGroup,
      isPickup: item.isPickup
    };
  });
  var categories = insuranceUnique_(publicVehicles.map(function (item) { return item.category; }));
  var provinces = insuranceUnique_(snapshot.provinceRows.map(function (row) {
    return insuranceField_(row, ['province_name', 'จังหวัด', 'จังหวัดที่จดทะเบียน']);
  }).filter(Boolean));

  return {
    ok: true,
    insuranceTypes: PP_INSURANCE_COVERAGE_TYPES,
    vehicleCategories: categories,
    provinces: provinces.sort(insuranceThaiSort_),
    usageTypes: PP_INSURANCE_USAGE_TYPES,
    modifications: PP_INSURANCE_MODIFICATIONS,
    companies: insurancePublicCompanies_(snapshot),
    vehicles: publicVehicles,
    source: 'PP Asset Insurance Product Master'
  };
}

/**
 * Return only coverage types that remain possible after the selected vehicle,
 * registration province, usage and body addition are known.
 */

function insuranceTypeOneAgeEligible_(vehicleYear) {
  var year = insuranceYear_(vehicleYear);
  if (!year) return false;
  var age = new Date().getFullYear() - year;
  return age >= 0 && age <= PP_INSURANCE_CONFIG.TYPE1_MAX_VEHICLE_AGE;
}

function webGetInsuranceCoverageOptionsOriginal_(input) {
  var normalized = insuranceNormalizeInput_(input || {});
  var response = {
    ok: true,
    options: [],
    message: ''
  };

  if (!normalized.vehicleId || !normalized.vehicleYear ||
      !normalized.registrationProvince || !normalized.usageType) {
    return response;
  }

  var snapshot = insuranceLoadSnapshot_();
  var vehicle = insuranceResolveVehicle_(normalized, snapshot.vehicles, snapshot.priceRows);
  if (!vehicle.ok) return response;

  // Type 1 is available for staff quotation only while the global vehicle-age
  // gate is satisfied. The officer still verifies the exact product criteria
  // from Age_Criteria before quoting.
  if (insuranceTypeOneAgeEligible_(normalized.vehicleYear)) {
    response.options.push({ value: '1', label: 'ประเภท 1', staffOnly: true });
  }

  ['2+', '3+', '3'].forEach(function (type) {
    var found = snapshot.rates.some(function (rate) {
      var product = insuranceFindById_(snapshot.products, insuranceField_(rate, ['product_id', 'รหัสผลิตภัณฑ์']));
      var evaluated = product && insuranceEvaluateRate_(rate, product, normalized, vehicle.value, snapshot, type);
      return evaluated && evaluated.ok && insurancePreferredInsurerMatches_(normalized.preferredInsurers, evaluated.result.insurer);
    });
    if (found) {
      response.options.push({ value: type, label: 'ประเภท ' + type });
    }
  });

  if (!response.options.length) {
    response.message = 'ยังไม่พบประเภทประกันภัยที่ตรงกับข้อมูลรถ';
  }
  return response;
}

/** Find and return rates that match the submitted motor-insurance details. */
function webFindInsuranceQuotesOriginal_(input) {
  var normalized = insuranceNormalizeInput_(input || {});
  var quoteId = insuranceCreateQuoteId_();

  if (normalized.insuranceType !== 'motor') {
    return insuranceStaffResult_(quoteId,
      'ประกันภัยรถยนต์เท่านั้น',
      'กรุณาใช้ข้อมูลในหน้านี้สำหรับประกันภัยรถยนต์');
  }

  if (normalized.coverageType === '1') {
    if (!normalized.vehicleYear) {
      return insuranceVerifyResult_(quoteId, 'กรุณาเลือกปีรถให้ครบถ้วนก่อนเลือกประเภท 1');
    }
    if (!insuranceTypeOneAgeEligible_(normalized.vehicleYear)) {
      var ageBlocked = insuranceVerifyResult_(quoteId,
        'ประเภท 1 รับรถอายุไม่เกิน ' + PP_INSURANCE_CONFIG.TYPE1_MAX_VEHICLE_AGE + ' ปี');
      insuranceLogCheck_(normalized, quoteId, ageBlocked.status, ageBlocked.message, null);
      return ageBlocked;
    }
    var typeOne = insuranceStaffResult_(quoteId,
      'ประเภท 1 — เจ้าหน้าที่ตรวจสอบและเสนอราคาเบี้ยประกันภัย',
      'ประเภท 1 ต้องตรวจสอบข้อมูลรถและเงื่อนไขของบริษัทประกันภัยก่อนเสนอราคาเบี้ยประกันภัย');
    typeOne.preferredInsurers = normalized.preferredInsurers;
    insuranceLogCheck_(normalized, quoteId, typeOne.status, typeOne.message, null);
    return typeOne;
  }

  if (['2+', '3+', '3'].indexOf(normalized.coverageType) === -1) {
    return insuranceVerifyResult_(quoteId, 'กรุณาเลือกประเภทประกันภัยรถยนต์');
  }

  if (!normalized.vehicleId || !normalized.vehicleYear ||
      !normalized.registrationProvince || !normalized.usageType) {
    return insuranceVerifyResult_(quoteId,
      'กรุณาเลือกข้อมูลรถ ปีรถ จังหวัดที่จดทะเบียนรถ และลักษณะการใช้งานรถให้ครบถ้วน');
  }

  var snapshot = insuranceLoadSnapshot_();
  var vehicle = insuranceResolveVehicle_(normalized, snapshot.vehicles, snapshot.priceRows);
  if (!vehicle.ok) {
    return insuranceVerifyResult_(quoteId, 'ไม่พบข้อมูลรถที่ตรงกับรายการที่เลือก');
  }

  var matches = [];
  snapshot.rates.forEach(function (rate) {
    var productId = insuranceField_(rate, ['product_id', 'รหัสผลิตภัณฑ์']);
    var product = insuranceFindById_(snapshot.products, productId);
    if (!product) return;
    var evaluated = insuranceEvaluateRate_(rate, product, normalized, vehicle.value, snapshot, normalized.coverageType);
    if (evaluated.ok && insurancePreferredInsurerMatches_(normalized.preferredInsurers, evaluated.result.insurer)) matches.push(evaluated.result);
  });

  matches.sort(function (left, right) {
    var a = insuranceNumber_(left.premium);
    var b = insuranceNumber_(right.premium);
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  });

  if (!matches.length) {
    var noMatch = insuranceVerifyResult_(quoteId,
      'ยังไม่พบแผนประกันภัยที่ตรงกับข้อมูลรถและเงื่อนไขที่เลือก');
    insuranceLogCheck_(normalized, quoteId, noMatch.status, noMatch.message, null, vehicle);
    return noMatch;
  }

  var returned = matches.slice(0, PP_INSURANCE_CONFIG.MAX_RATES);
  var sums = insuranceUnique_(returned.map(function (item) {
    return item.sumInsuredLabel || '';
  }).filter(Boolean));
  var response = {
    ok: true,
    status: 'QUOTE_READY',
    quoteId: quoteId,
    title: 'แผนประกันภัยที่ตรงกับข้อมูลเบื้องต้น',
    message: 'เบี้ยประกันภัยและความคุ้มครองเป็นข้อมูลเบื้องต้น เจ้าหน้าที่จะตรวจสอบเงื่อนไขของบริษัทประกันภัยก่อนจัดทำกรมธรรม์',
    vehicle: vehicle.public,
    rates: returned,
    sumOptions: sums,
    matchCount: matches.length,
    preferredInsurers: normalized.preferredInsurers,
    source: 'PP Asset Insurance Product Master'
  };
  insuranceLogCheck_(normalized, quoteId, response.status, response.message, returned[0] || null, vehicle);
  return response;
}

/** Save a request for officer follow-up in the Product Master log sheet. */
function webSubmitInsuranceLead(payload) {
  var data = insuranceNormalizeInput_(payload || {});
  var name = insuranceClean_(payload && (payload.name || payload.fullName));
  var phone = insuranceClean_(payload && (payload.phone || payload.telephone));
  var contactNote = insuranceClean_(payload && (payload.contactNote || payload.note));
  var sheet = insuranceGetSheet_(PP_INSURANCE_CONFIG.MASTER_SPREADSHEET_ID,
    [PP_INSURANCE_CONFIG.LOG_SHEET]);

  if (!sheet) {
    return { ok: false, message: 'ขณะนี้ยังไม่สามารถส่งข้อมูลได้ กรุณาติดต่อเจ้าหน้าที่' };
  }

  var lastColumn = sheet.getLastColumn();
  if (!lastColumn) return { ok: false, message: 'ขณะนี้ยังไม่สามารถส่งข้อมูลได้ กรุณาติดต่อเจ้าหน้าที่' };
  var headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  var values = {};
  var quoteId = insuranceClean_(payload && payload.quoteId) || insuranceCreateQuoteId_();
  values.timestamp = new Date();
  values.checked_at = new Date();
  values.quote_id = quoteId;
  values.name = name;
  values.phone = phone;
  values.contact_note = contactNote;
  values.vehicle_id = data.vehicleId;
  values.vehicle_category = data.vehicleCategory;
  values.vehicle_make = data.vehicleMake;
  values.vehicle_model = data.vehicleModel;
  values.vehicle_submodel = data.vehicleSubmodel;
  values.vehicle_year = data.vehicleYear || '';
  values.registration_province = data.registrationProvince;
  values.province = data.registrationProvince;
  values.usage_type = data.usageType;
  values.vehicle_use = data.usageType;
  values.modification = data.modification;
  values.insurance_type = data.coverageType;
  values.source_rate_id = insuranceClean_(payload && payload.rateId);
  values.insurer = insuranceClean_(payload && payload.insurer);
  values.package_name = insuranceClean_(payload && payload.packageName);
  values.premium_gross = insuranceClean_(payload && payload.premium);
  values.sum_insured = insuranceClean_(payload && (payload.sumInsured || payload.sumInsuredLabel));
  values.process_status = 'CONTACT_REQUESTED';
  values.quote_mode = 'PACKAGE_RATE';
  values.dlt_source_id = insuranceClean_(payload && payload.dltSourceId);
  values.dlt_price_from = insuranceClean_(payload && payload.dltPriceFrom);
  values.dlt_price_to = insuranceClean_(payload && payload.dltPriceTo);
  values.leaf_spring_coverage = insuranceClean_(payload && payload.leafSpringCoverage);
  values.floating_axle_coverage = insuranceClean_(payload && payload.floatingAxleCoverage);
  values.source_sheet = 'PP Asset Insurance Product Master';
  values.preferred_insurers = data.preferredInsurers.join(', ');
  var preferenceNote = data.preferredInsurers.length ? 'บริษัทที่ลูกค้าสนใจ: ' + data.preferredInsurers.join(', ') : 'บริษัทที่ลูกค้าสนใจ: ไม่ระบุ';
  values.contact_note = [contactNote, preferenceNote].filter(Boolean).join(' | ');
  values.note = [contactNote, preferenceNote].filter(Boolean).join(' | ');

  var row = headers.map(function (header) {
    var key = insuranceLogColumnKey_(header);
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : '';
  });

  var lock = LockService.getScriptLock();
  lock.tryLock(5000);
  try {
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, lastColumn).setValues([row]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, quoteId: quoteId, message: 'ส่งข้อมูลเรียบร้อยแล้ว เจ้าหน้าที่จะติดต่อกลับเพื่อเสนอราคาเบี้ยประกันภัย' };
}

function insuranceLoadSnapshot_() {
  var masterBook = SpreadsheetApp.openById(PP_INSURANCE_CONFIG.MASTER_SPREADSHEET_ID);
  var productRows = insuranceReadRows_(masterBook, [PP_INSURANCE_CONFIG.PRODUCT_SHEET]);
  var rateRows = insuranceReadRows_(masterBook, [PP_INSURANCE_CONFIG.RATE_SHEET]);
  var companyRows = insuranceReadRows_(masterBook, [PP_INSURANCE_CONFIG.COMPANY_SHEET]);
  var provinceRows = insuranceReadRows_(masterBook, [PP_INSURANCE_CONFIG.PROVINCE_SHEET]);
  var ageRows = insuranceReadRows_(masterBook, [PP_INSURANCE_CONFIG.AGE_SHEET]);
  var auditRows = insuranceReadRows_(masterBook, [PP_INSURANCE_CONFIG.AUDIT_SHEET]);
  var coverageRows = insuranceReadRows_(masterBook, [PP_INSURANCE_CONFIG.COVERAGE_SHEET]);
  var specialRows = insuranceReadRows_(masterBook, PP_INSURANCE_CONFIG.SPECIAL_MASTER_SHEETS);
  var vehicleRows = insuranceReadRows_(masterBook, [PP_INSURANCE_CONFIG.VEHICLE_SHEET]);
  var priceRows = insuranceReadRows_(masterBook, [PP_INSURANCE_CONFIG.PRICE_SHEET]);
  var modificationRows = insuranceReadRows_(masterBook, [PP_INSURANCE_CONFIG.MODIFICATION_SHEET]);

  var products = productRows.map(function (row) { return row; });
  var vehicles = vehicleRows.map(function (row, index) {
    return insuranceVehicleOption_(row, index);
  }).filter(function (item) {
    return item.category || item.make || item.model || item.submodel;
  });

  return {
    products: products,
    rates: rateRows,
    companies: companyRows,
    provinceRows: provinceRows,
    ageRows: ageRows,
    auditRows: auditRows,
    coverageRows: coverageRows,
    specialRows: specialRows,
    priceRows: priceRows,
    modificationRows: modificationRows,
    vehicles: vehicles
  };
}

function insuranceEvaluateRate_(rate, product, input, vehicle, snapshot, requestedType) {
  var rateId = insuranceField_(rate, ['rate_id', 'รหัสเรต', 'รหัสอัตรา']);
  if (!rateId || rateId === '#REF!') return { ok: false };
  if (!insuranceIsActive_(rate) || !insuranceIsActive_(product)) return { ok: false };

  var quoteMode = insuranceField_(rate, ['quote_mode', 'รูปแบบการเสนอราคา']);
  if (quoteMode && !/PACKAGE_RATE|AUTO|RATE|พร้อมเสนอ|อัตโนมัติ/i.test(quoteMode)) return { ok: false };

  var rateType = insuranceField_(rate, ['insurance_type', 'ประเภทประกัน', 'ประเภทประกันภัย']);
  var productType = insuranceField_(product, ['insurance_type', 'ประเภทประกัน', 'ประเภทประกันภัย']);
  if (!insuranceTypeMatches_(rateType || productType, requestedType)) return { ok: false };
  if (rateType && !insuranceTypeMatches_(rateType, requestedType)) return { ok: false };
  if (productType && !insuranceTypeMatches_(productType, requestedType)) return { ok: false };
  if (!insuranceCampaignCurrent_(
    insuranceField_(product, ['campaign_start', 'วันเริ่มแคมเปญ']),
    insuranceField_(product, ['campaign_end', 'วันสิ้นสุดแคมเปญ']))) return { ok: false };

  if (!insuranceVehicleMatchesRate_(rate, product, input, vehicle)) return { ok: false };
  if (!insuranceUsageMatches_(rate, product, input.usageType)) return { ok: false };
  if (!insuranceProvinceMatches_(rate, product, input.registrationProvince, snapshot.provinceRows)) return { ok: false };
  if (!insuranceAgeMatches_(rate, product, input.vehicleYear, snapshot.ageRows)) return { ok: false };
  if (!insuranceModificationAllowed_(input.modification, rate, product, snapshot)) return { ok: false };

  var premiumRaw = insuranceField_(rate, ['premium_gross', 'เบี้ยรวม', 'เบี้ยประกันภัย', 'premium', 'เบี้ย']);
  var premium = insuranceNumber_(premiumRaw);
  if (premium === null || premium <= 0) return { ok: false };

  var sumRaw = insuranceField_(rate, ['sum_insured', 'ทุนประกัน', 'ทุนประกันภัย', 'ทุนรถ']);
  if (!sumRaw) {
    var productSumFrom = insuranceField_(product, ['sum_insured_from', 'ทุนประกันขั้นต่ำ']);
    var productSumTo = insuranceField_(product, ['sum_insured_to', 'ทุนประกันสูงสุด']);
    if (productSumFrom && productSumTo) sumRaw = productSumFrom + '-' + productSumTo;
    else sumRaw = productSumFrom || productSumTo;
  }
  var sumNumber = insuranceNumber_(sumRaw);
  // A blank sum insured means the source did not state a vehicle-damage limit (common for Type 3); do not invent one.
  // When a limit is stated, only reject it when it exceeds the selected vehicle's DLT reference value.
  if (sumRaw && !insuranceRateSumMatchesVehiclePrice_(sumRaw, vehicle)) return { ok: false };
  if (input.sumInsured !== null && sumNumber !== input.sumInsured) return { ok: false };

  var insurerCode = insuranceField_(product, ['insurer_code', 'รหัสบริษัท']) ||
    insuranceField_(rate, ['insurer_code', 'รหัสบริษัท', 'insurer']);
  var company = insuranceFindById_(snapshot.companies, insurerCode, ['insurer_code', 'รหัสบริษัท']);
  var insurer = insuranceField_(company, ['insurer_name', 'ชื่อบริษัท', 'บริษัท']) ||
    insuranceField_(product, ['insurer_name', 'ชื่อบริษัท', 'บริษัท']) ||
    insuranceField_(rate, ['insurer_name', 'ชื่อบริษัท', 'บริษัท', 'insurer']);
  insurer = insurancePublicInsurerName_(insurer);
  var packageName = insuranceField_(rate, ['package_name', 'ชื่อแพ็กเกจ', 'แพ็กเกจ', 'ชื่อแผน']) ||
    insuranceField_(product, ['product_name', 'ชื่อผลิตภัณฑ์', 'ชื่อแพ็กเกจ', 'แพ็กเกจ']);
  var repairType = insuranceField_(rate, ['repair_type', 'ประเภทการซ่อม', 'ซ่อมอู่/ซ่อมห้าง']) ||
    insuranceField_(product, ['repair_type', 'ประเภทการซ่อม', 'ซ่อมอู่/ซ่อมห้าง']);

  var modificationCoverage = null;
  if (input.modification && insuranceModificationKey_(input.modification) !== 'none') {
    modificationCoverage = insuranceModificationCoverage_(input.modification, rate, product, snapshot);
  }

  return {
    ok: true,
    result: {
      rateId: rateId,
      productId: insuranceField_(rate, ['product_id', 'รหัสผลิตภัณฑ์']),
      insurer: insurer || 'บริษัทประกันภัย',
      insurerCode: insurerCode,
      packageName: packageName || 'แผนประกันภัยรถยนต์',
      insuranceType: insuranceNormalizeType_(requestedType),
      premium: premium,
      premiumLabel: insuranceMoneyLabel_(premium),
      sumInsured: sumNumber,
      sumInsuredLabel: insuranceMoneyRangeLabel_(sumRaw),
      repairType: insuranceCustomerRepairLabel_(repairType),
      modificationCoverage: modificationCoverage,
      conditions: insuranceField_(rate, ['key_conditions', 'เงื่อนไขสำคัญ', 'หมายเหตุ']),
      dataQuality: insuranceField_(product, ['data_quality', 'คุณภาพข้อมูล']),
      lastVerified: insuranceField_(product, ['last_verified', 'ตรวจสอบล่าสุด'])
    }
  };
}

function insuranceVehicleOption_(row, index) {
  var id = insuranceField_(row, ['รหัสรถ', 'vehicle_id', 'vehicle_code', 'รหัสรถยนต์']);
  var category = insuranceField_(row, ['ประเภทรถ', 'vehicle_category', 'category', 'ประเภทรถยนต์']);
  var make = insuranceField_(row, ['ยี่ห้อ', 'vehicle_make', 'make']);
  var model = insuranceField_(row, ['รุ่น', 'vehicle_model', 'model']);
  var submodel = insuranceField_(row, ['รุ่นย่อย', 'vehicle_submodel', 'submodel', 'แบบตัวถัง', 'รูปแบบตัวถัง']);
  var yearMin = insuranceYear_(insuranceField_(row, ['ปีเริ่มผลิต', 'year_min', 'vehicle_year_min', 'ปีรถเริ่มต้น']));
  var yearMax = insuranceYear_(insuranceField_(row, ['ปีสิ้นผลิต', 'year_max', 'vehicle_year_max', 'ปีรถสิ้นสุด']));
  return {
    vehicleId: id || 'VEHICLE_ROW_' + (index + 1),
    category: category,
    make: make,
    model: model,
    submodel: submodel,
    yearMin: yearMin,
    yearMax: yearMax,
    rateVehicleCode: insuranceField_(row, ['rate_vehicle_code', 'insurance_vehicle_code', 'รหัสเรต']),
    dltPriceFrom: insuranceNumber_(insuranceField_(row, ['dlt_price_from', 'ราคาประเมินขั้นต่ำ'])),
    dltPriceTo: insuranceNumber_(insuranceField_(row, ['dlt_price_to', 'ราคาประเมินขั้นสูง'])),
    vehicleGroup: insuranceField_(row, ['vehicle_group', 'กลุ่มรถ']) || insuranceVehicleGroup_(category, submodel),
    isPickup: /กระบะ|pickup/i.test([category, submodel].join(' ')),
    _row: row
  };
}

function insuranceResolveVehicle_(input, vehicles, priceRows) {
  function matches(vehicle, useId) {
    if (useId && input.vehicleId && vehicle.vehicleId !== input.vehicleId) return false;
    if (input.vehicleCategory && !insuranceSame_(vehicle.category, input.vehicleCategory)) return false;
    if (input.vehicleMake && !insuranceSame_(vehicle.make, input.vehicleMake)) return false;
    if (input.vehicleModel && !insuranceSame_(vehicle.model, input.vehicleModel)) return false;
    if (input.vehicleSubmodel && !insuranceSame_(vehicle.submodel, input.vehicleSubmodel)) return false;
    if (input.vehicleYear && vehicle.yearMin && input.vehicleYear < vehicle.yearMin) return false;
    if (input.vehicleYear && vehicle.yearMax && input.vehicleYear > vehicle.yearMax) return false;
    return true;
  }

  var candidates = (vehicles || []).filter(function (vehicle) {
    return matches(vehicle, true);
  });
  // The UI uses a representative row for a duplicate submodel. If that row
  // does not cover the selected year, resolve again from the selected facts
  // instead of failing because of an internal vehicle ID.
  if (input.vehicleId && !candidates.length) {
    candidates = (vehicles || []).filter(function (vehicle) {
      return matches(vehicle, false);
    });
  }

  if (candidates.length !== 1) return { ok: false };
  var vehicle = candidates[0];
  var dlt = insuranceFindDltPrice_(vehicle, priceRows || [], input.vehicleYear);
  var priceFrom = dlt ? dlt.priceFrom : vehicle.dltPriceFrom;
  var priceTo = dlt ? dlt.priceTo : vehicle.dltPriceTo;
  var priceSourceId = dlt ? dlt.sourceId : insuranceField_(vehicle._row, ['dlt_source_id', 'แหล่งราคารถ']);
  if (priceFrom !== null && priceTo !== null) {
    vehicle.dltPriceFrom = priceFrom;
    vehicle.dltPriceTo = priceTo;
  }
  return {
    ok: true,
    value: vehicle,
    public: {
      category: vehicle.category,
      make: vehicle.make,
      model: vehicle.model,
      submodel: vehicle.submodel,
      year: input.vehicleYear,
      dltSourceId: priceSourceId || '',
      dltPriceFrom: priceFrom !== null ? priceFrom : '',
      dltPriceTo: priceTo !== null ? priceTo : '',
      dltPriceLabel: priceFrom !== null && priceTo !== null ? insuranceMoneyLabel_(priceFrom) + '–' + insuranceMoneyLabel_(priceTo) : ''
    }
  };
}

/** Match the selected vehicle to an OK row in the DLT reference table. */
function insuranceFindDltPrice_(vehicle, priceRows, selectedYear) {
  var make = insuranceNormalizeText_(vehicle && vehicle.make);
  var modelText = insuranceClean_(vehicle && vehicle.model).toUpperCase();
  var submodelText = insuranceClean_(vehicle && vehicle.submodel).toUpperCase();
  var model = insuranceNormalizeText_(modelText);
  var submodel = insuranceNormalizeText_(submodelText);
  var targetText = [modelText, submodelText].filter(function (value) { return value; }).join(' ');
  var targetTokens = targetText.split(/[^a-z0-9ก-๙]+/i).filter(function (token) { return token.length > 1; }).map(insuranceNormalizeText_);
  var best = null;
  (priceRows || []).forEach(function (row) {
    if (insuranceField_(row, ['parse_status', 'สถานะการอ่าน']) !== 'OK') return;
    if (make && insuranceNormalizeText_(insuranceField_(row, ['make', 'ยี่ห้อ'])) !== make) return;
    var rowFrom = insuranceYear_(insuranceField_(row, ['year_from', 'ปีเริ่มต้น']));
    var rowTo = insuranceYear_(insuranceField_(row, ['year_to', 'ปีสิ้นสุด']));
    if (!rowFrom || !rowTo) return;
    if (selectedYear && (selectedYear < rowFrom || selectedYear > rowTo)) return;
    var dltModelText = insuranceClean_(insuranceField_(row, ['model', 'รุ่น'])).toUpperCase();
    var dltModel = insuranceNormalizeText_(dltModelText);
    if (!dltModel) return;
    var rowTokens = dltModelText.split(/[^a-z0-9ก-๙]+/i).filter(function (token) { return token.length > 1; }).map(insuranceNormalizeText_);
    var overlap = targetTokens.filter(function (token) { return rowTokens.indexOf(token) !== -1; }).length;
    var modelContains = !!model && (dltModel.indexOf(model) !== -1 || model.indexOf(dltModel) !== -1);
    var submodelContains = !!submodel && (dltModel.indexOf(submodel) !== -1 || submodel.indexOf(dltModel) !== -1);
    if (!overlap && !modelContains && !submodelContains) return;
    var score = overlap * 10 + (modelContains ? 30 : 0) + (submodelContains ? 40 : 0) +
      (dltModel === model ? 50 : 0) + Math.min(dltModel.length, 60) / 100;
    if (!best || score > best.score) {
      best = {
        score: score,
        sourceId: insuranceField_(row, ['dlt_id', 'source_id']),
        priceFrom: insuranceNumber_(insuranceField_(row, ['price_from', 'ราคาขั้นต่ำ'])),
        priceTo: insuranceNumber_(insuranceField_(row, ['price_to', 'ราคาขั้นสูง']))
      };
    }
  });
  return best && best.priceFrom !== null && best.priceTo !== null ? best : null;
}

function insuranceExplicitExclusionSegments_(value) {
  return insuranceClean_(value).split(/[;|\n]+/).map(function (segment) { return insuranceClean_(segment); }).filter(function (segment) {
    return /(ยกเว้น|ไม่รับ|ห้าม|excluded?|not\s+eligible)/i.test(segment);
  });
}

/** Check explicit make/model exclusions documented for the selected product or rate. */
function insuranceVehicleExplicitlyExcluded_(rate, product, vehicle) {
  var make = insuranceClean_(vehicle && vehicle.make);
  var modelValues = [vehicle && vehicle.model, vehicle && vehicle.submodel].map(insuranceClean_).filter(function (value) {
    return insuranceNormalizeText_(value).length >= 2;
  });
  var excludedMakes = [
    insuranceField_(rate, ['excluded_makes', 'excluded_make', 'exclude_makes', 'excluded_brands', 'ยี่ห้อยกเว้น', 'ยี่ห้อที่ยกเว้น']),
    insuranceField_(product, ['excluded_makes', 'excluded_make', 'exclude_makes', 'excluded_brands', 'ยี่ห้อยกเว้น', 'ยี่ห้อที่ยกเว้น'])
  ].filter(Boolean).join('|');
  var excludedModels = [
    insuranceField_(rate, ['excluded_models', 'excluded_model', 'exclude_models', 'รุ่นยกเว้น', 'รุ่นที่ยกเว้น']),
    insuranceField_(product, ['excluded_models', 'excluded_model', 'exclude_models', 'รุ่นยกเว้น', 'รุ่นที่ยกเว้น'])
  ].filter(Boolean).join('|');
  if (make && insuranceValueListMatches_(excludedMakes, make)) return true;
  if (modelValues.some(function (model) { return insuranceValueListMatches_(excludedModels, model); })) return true;

  var documentedText = [
    insuranceField_(rate, ['make_group', 'กลุ่มยี่ห้อ', 'ยี่ห้อ/รุ่น']),
    insuranceField_(rate, ['key_conditions', 'เงื่อนไขสำคัญ', 'หมายเหตุ']),
    insuranceField_(rate, ['notes', 'หมายเหตุเพิ่มเติม']),
    insuranceField_(product, ['key_conditions', 'เงื่อนไขสำคัญ', 'หมายเหตุ']),
    insuranceField_(product, ['notes', 'หมายเหตุเพิ่มเติม'])
  ].filter(Boolean).join('|');
  return insuranceExplicitExclusionSegments_(documentedText).some(function (segment) {
    var normalizedSegment = insuranceNormalizeText_(segment);
    if (make && normalizedSegment.indexOf(insuranceNormalizeText_(make)) !== -1) return true;
    return modelValues.some(function (model) {
      var normalizedModel = insuranceNormalizeText_(model);
      return normalizedModel && normalizedSegment.indexOf(normalizedModel) !== -1;
    });
  });
}

function insurancePublicInsurerName_(value) {
  var name = insuranceClean_(value);
  var normalized = insuranceNormalizeText_(name);
  if (!name) return '';
  if (normalized.indexOf('ชับบ์สามัคคี') !== -1) {
    return 'ชับบ์สามัคคีประกันภัย';
  }
  return name;
}

function insurancePreferredInsurerNames_(value) {
  if (value === null || value === undefined || value === '') return [];
  var raw = Array.isArray(value) ? value : insuranceClean_(value).split(/[,|;\n]+/);
  return insuranceUnique_(raw.map(function (item) { return insuranceClean_(item); }).filter(Boolean));
}

/** Match the visible insurer name selected by the customer. */
function insurancePreferredInsurerMatches_(preferred, insurer) {
  var requested = insurancePreferredInsurerNames_(preferred);
  if (!requested.length) return true;
  var candidate = insuranceNormalizeText_(insurancePublicInsurerName_(insurer));
  if (!candidate) return false;
  return requested.some(function (name) {
    return insuranceNormalizeText_(insurancePublicInsurerName_(name)) === candidate;
  });
}

/** Return unique insurer names sourced from the live master data. */
function insurancePublicCompanies_(snapshot) {
  var names = [];
  (snapshot.companies || []).forEach(function (row) {
    if (!insuranceIsActive_(row)) return;
    var name = insurancePublicInsurerName_(insuranceField_(row, ['insurer_name', 'ชื่อบริษัท', 'บริษัท', 'company_name', 'ชื่อผู้รับประกัน']));
    if (name) names.push(name);
  });
  (snapshot.products || []).forEach(function (row) {
    if (!insuranceIsActive_(row)) return;
    var name = insurancePublicInsurerName_(insuranceField_(row, ['insurer_name', 'ชื่อบริษัท', 'บริษัท', 'company_name', 'ชื่อผู้รับประกัน']));
    if (name) names.push(name);
  });
  return insuranceUnique_(names).sort(insuranceThaiSort_).map(function (name) {
    return { name: name, label: name };
  });
}

function insuranceVehicleMatchesRate_(rate, product, input, vehicle) {
  if (insuranceVehicleExplicitlyExcluded_(rate, product, vehicle)) return false;
  var vehicleCode = insuranceField_(rate, ['vehicle_code', 'รหัสรถ', 'รหัสรถยนต์', 'vehicle_id']);
  var mappedCode = insuranceField_(vehicle._row, ['rate_vehicle_code', 'insurance_vehicle_code', 'รหัสเรต']);
  if (vehicleCode && mappedCode && !insuranceTokenMatches_(vehicleCode, mappedCode)) return false;

  var rateGroup = insuranceField_(rate, ['vehicle_group', 'กลุ่มรถ']) ||
    insuranceField_(product, ['vehicle_group', 'กลุ่มรถ']);
  if (rateGroup && !insuranceGroupMatches_(rateGroup, vehicle.vehicleGroup, vehicle.category, vehicle.submodel)) return false;

  var rateMake = insuranceField_(rate, ['vehicle_make', 'ยี่ห้อ']);
  var rateModel = insuranceField_(rate, ['vehicle_model', 'รุ่น']);
  if (rateMake && !insuranceSame_(rateMake, vehicle.make)) return false;
  if (rateModel && !insuranceSame_(rateModel, vehicle.model)) return false;

  var makeGroup = insuranceField_(rate, ['make_group', 'กลุ่มยี่ห้อ', 'ยี่ห้อ/รุ่น']);
  if (makeGroup && !insuranceMakeGroupMatches_(makeGroup, vehicle.make, vehicle.model)) return false;
  return true;
}

function insuranceUsageMatches_(rate, product, usage) {
  var expected = insuranceField_(rate, ['usage_type', 'ลักษณะการใช้งาน', 'การใช้รถ']) ||
    insuranceField_(product, ['usage_type', 'ลักษณะการใช้งาน', 'การใช้รถ']);
  if (!expected) return false;
  if (!usage || insuranceSame_(usage, 'ไม่แน่ใจ')) return false;
  var aliases = {
    'รถพาณิชย์': 'รถพาณิชย์|พาณิชย์',
    'รถรับจ้างสาธารณะ/แท็กซี่': 'รถรับจ้างสาธารณะ|รับจ้างสาธารณะ|แท็กซี่|รถแท็กซี่',
    'App Car': 'App Car|รับจ้างผ่านแอป|แอป|แกร็บคาร์',
    'ขนส่งสินค้า': 'ขนส่งสินค้า|ส่งสินค้า|พาณิชย์'
  };
  return insuranceValueListMatches_(expected, aliases[usage] || usage);
}

function insuranceProvinceMatches_(rate, product, registrationProvince, provinceRows) {
  if (!registrationProvince) return false;
  var region = insuranceField_(rate, ['region', 'พื้นที่', 'โซน']) ||
    insuranceField_(product, ['region', 'พื้นที่', 'โซน']);
  if (!region || /ทุกจังหวัด|ทั่วประเทศ|all|nationwide/i.test(region)) return true;

  var province = (provinceRows || []).filter(function (row) {
    return insuranceSame_(insuranceField_(row, ['province_name', 'จังหวัด', 'จังหวัดที่จดทะเบียน']), registrationProvince);
  })[0];
  if (!province) return false;
  var accepted = [registrationProvince,
    insuranceField_(province, ['eligible_region_labels', 'region_labels', 'กลุ่มพื้นที่']),
    insuranceField_(province, ['metro_rate_group', 'กลุ่มพื้นที่กรุงเทพ']),
    insuranceField_(province, ['sompo_zone', 'โซนบริษัท'])].join('|');
  return insuranceListMatches_(accepted, region);
}

function insuranceAgeMatches_(rate, product, vehicleYear, ageRows) {
  if (!vehicleYear) return false;
  var age = new Date().getFullYear() - vehicleYear;
  var min = insuranceBoundedNumber_(insuranceField_(rate, ['min_vehicle_age', 'อายุรถขั้นต่ำ']));
  var max = insuranceBoundedNumber_(insuranceField_(rate, ['max_vehicle_age', 'อายุรถสูงสุด']));
  if (min !== null && min !== 'INVALID' && age < min) return false;
  if (max !== null && max !== 'INVALID' && age > max) return false;
  if (min === 'INVALID' || max === 'INVALID') return false;

  var productId = insuranceField_(product, ['product_id', 'รหัสผลิตภัณฑ์']);
  var criteria = (ageRows || []).filter(function (row) {
    return insuranceSame_(insuranceField_(row, ['product_id', 'รหัสผลิตภัณฑ์']), productId) &&
      insuranceIsActive_(row);
  });
  if (!criteria.length) return true;
  return criteria.some(function (row) {
    var rowMin = insuranceBoundedNumber_(insuranceField_(row, ['min_vehicle_age', 'อายุรถขั้นต่ำ']));
    var rowMax = insuranceBoundedNumber_(insuranceField_(row, ['max_vehicle_age', 'อายุรถสูงสุด']));
    return rowMin !== 'INVALID' && rowMax !== 'INVALID' &&
      (rowMin === null || age >= rowMin) && (rowMax === null || age <= rowMax);
  });
}

/**
 * Make the only customer-visible answer for the two requested additions.
 * The lookup checks explicit fields/remarks in the applicable master rows.
 * If a plan does not explicitly include the addition, it is treated as not
 * covered under that plan's stated conditions.
 */
function insuranceModificationCoverage_(modification, rate, product, snapshot) {
  var ruleRows = insuranceModificationRules_(rate, product, snapshot);
  if (ruleRows.length) {
    var rule = ruleRows[0];
    return {
      modification: modification,
      leafSpring: insuranceField_(rule, ['leaf_spring_coverage']) || 'ไม่คุ้มครอง',
      floatingAxle: insuranceField_(rule, ['floating_axle_coverage']) || 'ไม่คุ้มครอง'
    };
  }
  var rows = (snapshot.specialRows || []).filter(function (row) {
    return insuranceSpecialRowApplies_(row, modification, rate, product);
  });
  var sources = rows.concat([rate, product]);
  var leaf = insuranceCoverageStatus_(sources,
    ['แหนบ', 'leafspring', 'leaf_spring', 'leaf spring']);
  var axle = insuranceCoverageStatus_(sources,
    ['เพลาลอย', 'เพลา', 'floatingaxle', 'floating_axle', 'floating axle']);

  return {
    modification: modification,
    leafSpring: leaf || 'ไม่คุ้มครอง',
    floatingAxle: axle || 'ไม่คุ้มครอง'
  };
}

function insuranceModificationRules_(rate, product, snapshot) {
  var rateId = insuranceField_(rate, ['rate_id', 'รหัสเรต', 'รหัสอัตรา']);
  var productId = insuranceField_(product, ['product_id', 'รหัสผลิตภัณฑ์']);
  var rows = snapshot.modificationRows || [];
  var rateRows = rows.filter(function (row) {
    return rateId && insuranceSame_(insuranceField_(row, ['rate_id']), rateId);
  });
  if (rateRows.length) return rateRows;
  return rows.filter(function (row) {
    return productId && insuranceSame_(insuranceField_(row, ['product_id']), productId);
  });
}

function insuranceModificationAllowed_(modification, rate, product, snapshot) {
  var key = insuranceModificationKey_(modification);
  if (key === 'none') return true;
  if (key === 'other') return false;

  var rules = insuranceModificationRules_(rate, product, snapshot);
  if (rules.length) {
    return rules.some(function (rule) {
      var excluded = insuranceField_(rule, ['excluded_modifications']);
      var eligible = insuranceField_(rule, ['eligible_modifications']);
      if (excluded && insuranceListMatches_(excluded, modification)) return false;
      return !!eligible && insuranceListMatches_(eligible, modification);
    });
  }

  var text = [
    insuranceField_(rate, ['key_conditions', 'เงื่อนไขสำคัญ', 'หมายเหตุ']),
    insuranceField_(product, ['key_conditions', 'เงื่อนไขสำคัญ', 'หมายเหตุ'])
  ].join(' | ');
  return insuranceConditionAllowsModification_(text, modification);
}

function insuranceModificationTerms_(modification) {
  var key = insuranceModificationKey_(modification);
  if (key === 'cage') return ['คอก', 'แซง', 'รั้ว'];
  if (key === 'closed') return ['ตู้ทึบ'];
  if (key === 'dry') return ['ตู้แห้ง'];
  return [];
}

function insuranceConditionAllowsModification_(text, modification) {
  var terms = insuranceModificationTerms_(modification);
  if (!terms.length) return false;
  var foundPositive = false;
  var foundNegative = false;
  terms.forEach(function (term) {
    var position = String(text || '').indexOf(term);
    while (position !== -1) {
      var before = String(text || '').slice(Math.max(0, position - 42), position);
      var after = String(text || '').slice(position, position + term.length + 20);
      if (/(ไม่รับ|ไม่คุ้มครอง|ไม่รวม|ยกเว้น|ห้าม|งดรับ)/i.test(before + ' ' + after)) {
        foundNegative = true;
      } else {
        foundPositive = true;
      }
      position = String(text || '').indexOf(term, position + term.length);
    }
  });
  return foundPositive && !foundNegative;
}

function insuranceSpecialRowApplies_(row, modification, rate, product) {
  var rowRate = insuranceField_(row, ['rate_id', 'รหัสเรต', 'รหัสอัตรา']);
  var rowProduct = insuranceField_(row, ['product_id', 'รหัสผลิตภัณฑ์']);
  var rateId = insuranceField_(rate, ['rate_id', 'รหัสเรต', 'รหัสอัตรา']);
  var productId = insuranceField_(product, ['product_id', 'รหัสผลิตภัณฑ์']);
  var idMatch = (!rowRate && !rowProduct) ||
    (rowRate && insuranceSame_(rowRate, rateId)) ||
    (rowProduct && insuranceSame_(rowProduct, productId));
  if (!idMatch) return false;
  var body = insuranceField_(row, [
    'modification', 'modification_type', 'body_type', 'ประเภทรถต่อเติม',
    'ลักษณะการต่อเติม', 'ลักษณะรถ', 'รูปแบบตัวถัง'
  ]);
  return !body || insuranceModificationKey_(body) === insuranceModificationKey_(modification) ||
    insuranceListMatches_(body, modification);
}

function insuranceCoverageStatus_(rows, terms) {
  var normalizedTerms = terms.map(insuranceNormalizeText_);
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    if (!row) continue;
    var headers = row._headers || [];
    var cells = row._cells || [];
    for (var h = 0; h < headers.length; h += 1) {
      var headerText = insuranceNormalizeText_(headers[h]);
      if (normalizedTerms.some(function (term) { return headerText.indexOf(term) !== -1; })) {
        var status = insuranceStatusFromText_(cells[h]);
        if (status) return status;
      }
    }
    var rowText = row._text || '';
    for (var t = 0; t < normalizedTerms.length; t += 1) {
      var position = rowText.indexOf(normalizedTerms[t]);
      if (position !== -1) {
        var excerpt = rowText.slice(Math.max(0, position - 40), position + 120);
        var textStatus = insuranceStatusFromText_(excerpt);
        if (textStatus) return textStatus;
      }
    }
  }
  return '';
}

function insuranceStatusFromText_(value) {
  var text = insuranceClean_(value).toLowerCase();
  if (!text) return '';
  if (/ไม่\s*(คุ้มครอง|รวม|รับ)|ยกเว้น|ไม่รับ|not\s*covered|excluded|no\s*cover|false|^no$|^0$/.test(text)) {
    return 'ไม่คุ้มครอง';
  }
  if (/คุ้มครอง|รวม|รับ|included|covered|yes|true|^1$|^y$/.test(text)) {
    return 'คุ้มครอง';
  }
  return '';
}

function insuranceIsActive_(row) {
  var status = insuranceField_(row, ['validity_status', 'status', 'สถานะ', 'สถานะข้อมูล']);
  if (!status) return true;
  return /active|verified|พร้อม|ใช้งาน|ยืนยัน/i.test(status) &&
    !/inactive|expired|archived|ยกเลิก|หมดอายุ/i.test(status);
}

function insuranceFindById_(rows, id, aliases) {
  if (!id) return null;
  var names = aliases || ['product_id', 'รหัสผลิตภัณฑ์', 'insurer_code', 'รหัสบริษัท'];
  return (rows || []).filter(function (row) {
    return insuranceSame_(insuranceField_(row, names), id);
  })[0] || null;
}

function insuranceReadRows_(book, sheetNames) {
  var sheet = insuranceGetSheetFromBook_(book, sheetNames);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  if (!lastRow || !lastColumn) return [];
  var values = sheet.getRange(1, 1, lastRow, lastColumn).getDisplayValues();
  var headers = values[0].map(function (header) { return insuranceClean_(header); });
  return values.slice(1).map(function (cells) {
    var row = { _headers: headers, _cells: cells, _alias: {}, _text: cells.join(' | ') };
    headers.forEach(function (header, index) {
      if (!header) return;
      row[header] = cells[index] === undefined ? '' : cells[index];
      row._alias[insuranceNormalizeHeader_(header)] = cells[index] === undefined ? '' : cells[index];
    });
    return row;
  }).filter(function (row) {
    return row._cells.some(function (value) { return insuranceClean_(value); });
  });
}

function insuranceGetSheet_(spreadsheetId, sheetNames) {
  return insuranceGetSheetFromBook_(SpreadsheetApp.openById(spreadsheetId), sheetNames);
}

function insuranceGetSheetFromBook_(book, sheetNames) {
  for (var i = 0; i < sheetNames.length; i += 1) {
    var sheet = book.getSheetByName(sheetNames[i]);
    if (sheet) return sheet;
  }
  return null;
}

function insuranceNormalizeInput_(raw) {
  raw = raw || {};
  return {
    insuranceType: insuranceClean_(raw.insuranceType || 'motor').toLowerCase(),
    coverageType: insuranceNormalizeType_(raw.coverageType || raw.insurance_type),
    vehicleId: insuranceClean_(raw.vehicleId || raw.vehicle_id),
    vehicleCategory: insuranceClean_(raw.vehicleCategory || raw.vehicle_category),
    vehicleMake: insuranceClean_(raw.vehicleMake || raw.vehicle_make),
    vehicleModel: insuranceClean_(raw.vehicleModel || raw.vehicle_model),
    vehicleSubmodel: insuranceClean_(raw.vehicleSubmodel || raw.vehicle_submodel),
    vehicleYear: insuranceYear_(raw.vehicleYear || raw.vehicle_year),
    usageType: insuranceClean_(raw.usageType || raw.usage_type || raw.vehicleUse || raw.vehicle_use),
    registrationProvince: insuranceClean_(raw.registrationProvince || raw.registration_province || raw.province),
    modification: insuranceClean_(raw.modification || 'ไม่มี'),
    preferredInsurers: insurancePreferredInsurerNames_(raw.preferredInsurers || raw.preferred_insurers || raw.insurers || raw.insurerNames),
    sumInsured: insuranceNumber_(raw.sumInsured || raw.sum_insured),
    repairType: insuranceClean_(raw.repairType || raw.repair_type)
  };
}

function insuranceLogCheck_(input, quoteId, status, note, rate, vehicle) {
  try {
    var sheet = insuranceGetSheet_(PP_INSURANCE_CONFIG.MASTER_SPREADSHEET_ID,
      [PP_INSURANCE_CONFIG.LOG_SHEET]);
    if (!sheet || !sheet.getLastColumn()) return;
    var lastColumn = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
    var values = {
      timestamp: new Date(), checked_at: new Date(), quote_id: quoteId,
      vehicle_id: input.vehicleId, vehicle_category: input.vehicleCategory,
      vehicle_make: input.vehicleMake, vehicle_model: input.vehicleModel,
      vehicle_submodel: input.vehicleSubmodel, vehicle_year: input.vehicleYear || '',
      registration_province: input.registrationProvince, province: input.registrationProvince,
      usage_type: input.usageType, vehicle_use: input.usageType,
      modification: input.modification, insurance_type: input.coverageType,
      source_rate_id: rate ? rate.rateId : '', insurer: rate ? rate.insurer : '',
      package_name: rate ? rate.packageName : '', premium_gross: rate ? rate.premium : '',
      sum_insured: rate ? (rate.sumInsuredLabel || rate.sumInsured || '') : '',
      process_status: status, quote_mode: rate ? 'PACKAGE_RATE' : 'STAFF_QUOTE', note: note,
      dlt_source_id: vehicle && vehicle.public ? vehicle.public.dltSourceId : '',
      dlt_price_from: vehicle && vehicle.public ? vehicle.public.dltPriceFrom : '',
      dlt_price_to: vehicle && vehicle.public ? vehicle.public.dltPriceTo : '',
      leaf_spring_coverage: rate && rate.modificationCoverage ? rate.modificationCoverage.leafSpring : '',
      floating_axle_coverage: rate && rate.modificationCoverage ? rate.modificationCoverage.floatingAxle : '',
      source_sheet: 'PP Asset Insurance Product Master'
    };
    var row = headers.map(function (header) {
      var key = insuranceLogColumnKey_(header);
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : '';
    });
    var lock = LockService.getScriptLock();
    lock.tryLock(5000);
    try {
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, lastColumn).setValues([row]);
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    console.error('Insurance Web Check logging failed: ' + error);
  }
}

function insuranceLogColumnKey_(header) {
  var key = insuranceNormalizeHeader_(header);
  if (/timestamp|checkedat|เวลาที่|วันที่ตรวจ/.test(key)) return 'timestamp';
  if (/quoteid|เลขที่ใบเสนอ|รหัสการค้นหา/.test(key)) return 'quote_id';
  if (/ชื่อผู้ติดต่อ|ชื่อลูกค้า|fullname|^name$/.test(key)) return 'name';
  if (/โทรศัพท์|เบอร์โทร|phone|telephone/.test(key)) return 'phone';
  if (/contactnote|รายละเอียดการติดต่อ/.test(key)) return 'contact_note';
  if (/vehicleid|รหัสรถ/.test(key)) return 'vehicle_id';
  if (/vehiclecategory|ประเภทรถ/.test(key)) return 'vehicle_category';
  if (/vehiclemake|ยี่ห้อ/.test(key)) return 'vehicle_make';
  if (/vehiclemodel|^รุ่น$/.test(key)) return 'vehicle_model';
  if (/vehiclesubmodel|รุ่นย่อย|แบบตัวถัง/.test(key)) return 'vehicle_submodel';
  if (/vehicleyear|ปีรถ|ปีคศ/.test(key)) return 'vehicle_year';
  if (/registrationprovince|จังหวัดที่จดทะเบียน|จังหวัดจดทะเบียน/.test(key)) return 'registration_province';
  if (/^province$|จังหวัด/.test(key)) return 'province';
  if (/usagetype|vehicleuse|ลักษณะการใช้งาน|การใช้รถ/.test(key)) return 'usage_type';
  if (/modification|การต่อเติม|ลักษณะรถกระบะ/.test(key)) return 'modification';
  if (/insurancetype|ประเภทประกัน/.test(key)) return 'insurance_type';
  if (/sourcerateid|รหัสเรต|รหัสอัตรา/.test(key)) return 'source_rate_id';
  if (/preferredinsurer|บริษัทที่สนใจ|บริษัทประกันที่สนใจ/.test(key)) return 'preferred_insurers';
  if (/^insurer$|insurername|ชื่อบริษัท|บริษัท/.test(key)) return 'insurer';
  if (/packagename|ชื่อแพ็กเกจ|ชื่อแผน|แพ็กเกจ/.test(key)) return 'package_name';
  if (/premiumgross|premium|เบี้ย/.test(key)) return 'premium_gross';
  if (/suminsured|ทุนประกัน|ทุนรถ/.test(key)) return 'sum_insured';
  if (/processstatus|สถานะการดำเนินการ/.test(key)) return 'process_status';
  if (/quotemode|รูปแบบการเสนอราคา/.test(key)) return 'quote_mode';
  if (/dltsourceid/.test(key)) return 'dlt_source_id';
  if (/dltpricefrom/.test(key)) return 'dlt_price_from';
  if (/dltpriceto/.test(key)) return 'dlt_price_to';
  if (/leafspringcoverage/.test(key)) return 'leaf_spring_coverage';
  if (/floatingaxlecoverage/.test(key)) return 'floating_axle_coverage';
  if (/sourcesheet/.test(key)) return 'source_sheet';
  if (/^note$|หมายเหตุ/.test(key)) return 'note';
  return key;
}

function insuranceStaffResult_(quoteId, title, message) {
  return {
    ok: true, status: 'STAFF_QUOTE', quoteId: quoteId, title: title,
    message: message, rates: [], source: 'PP Asset Insurance Product Master'
  };
}

function insuranceVerifyResult_(quoteId, message) {
  return {
    ok: true, status: 'VERIFY_SOURCE', quoteId: quoteId,
    title: 'ให้เจ้าหน้าที่ตรวจสอบและเสนอราคาเบี้ยประกันภัย', message: message,
    rates: [], source: 'PP Asset Insurance Product Master'
  };
}

function insuranceNormalizeType_(value) {
  var text = insuranceClean_(value).toUpperCase().replace(/ประเภท/g, '').replace(/ประกันภัยรถยนต์/g, '');
  if (text === 'TYPE1' || text === '1') return '1';
  if (text === 'TYPE2+' || text === '2PLUS' || text === '2+') return '2+';
  if (text === 'TYPE3+' || text === '3PLUS' || text === '3+') return '3+';
  if (text === 'TYPE3' || text === '3') return '3';
  return insuranceClean_(value);
}

function insuranceTypeMatches_(value, requested) {
  if (!value || !requested) return false;
  return insuranceClean_(value).split(/[,|\/;\n]+/).some(function (token) {
    return insuranceNormalizeType_(token) === insuranceNormalizeType_(requested);
  });
}

function insuranceCampaignCurrent_(start, end) {
  var now = new Date();
  var begin = insuranceParseDate_(start);
  var finish = insuranceParseDate_(end);
  return (!begin || now >= begin) && (!finish || now <= finish);
}

function insuranceParseDate_(value) {
  var text = insuranceClean_(value);
  if (!text) return null;
  var direct = new Date(text);
  if (!isNaN(direct.getTime())) return direct;
  var match = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (!match) return null;
  var year = Number(match[3]);
  if (year > 2400) year -= 543;
  return new Date(year, Number(match[2]) - 1, Number(match[1]));
}

function insuranceYear_(value) {
  var year = insuranceNumber_(value);
  if (year === null) return null;
  return year > 2400 ? year - 543 : year;
}

function insuranceBoundedNumber_(value) {
  var text = insuranceClean_(value);
  if (!text || /ไม่จำกัด|unlimited|any/i.test(text)) return null;
  var number = insuranceNumber_(text);
  return number === null ? 'INVALID' : number;
}

function insuranceNumber_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;
  var text = insuranceClean_(value).replace(/,/g, '').replace(/บาท|ปี|฿/g, '').trim();
  var range = text.match(/^(\d+(?:\.\d+)?)\s*[-–ถึง]\s*(\d+(?:\.\d+)?)$/);
  if (range) return Number(range[1]);
  var number = Number(text);
  return isFinite(number) ? number : null;
}

function insuranceMoneyLabel_(value) {
  var number = insuranceNumber_(value);
  if (number === null) return insuranceClean_(value);
  return number.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' บาท';
}

function insuranceMoneyRangeLabel_(value) {
  var text = insuranceClean_(value);
  if (!text) return '';
  var range = text.match(/^(\d[\d,]*)\s*[-–ถึง]\s*(\d[\d,]*)$/);
  if (range) return Number(range[1].replace(/,/g, '')).toLocaleString('en-US') + '–' + Number(range[2].replace(/,/g, '')).toLocaleString('en-US') + ' บาท';
  var number = insuranceNumber_(text);
  return number === null ? text : insuranceMoneyLabel_(number);
}

function insuranceMoneyBounds_(value) {
  var text = insuranceClean_(value);
  if (!text) return null;
  var range = text.match(/^(\d[\d,]*)\s*[-–ถึง]\s*(\d[\d,]*)$/);
  if (range) {
    var from = Number(range[1].replace(/,/g, ''));
    var to = Number(range[2].replace(/,/g, ''));
    if (!isFinite(from) || !isFinite(to)) return null;
    return { min: Math.min(from, to), max: Math.max(from, to) };
  }
  var number = insuranceNumber_(text);
  return number === null ? null : { min: number, max: number };
}

/** Automatic package rates must use a sum insured supported by the selected vehicle price reference. */
function insuranceRateSumMatchesVehiclePrice_(sumRaw, vehicle) {
  var sum = insuranceMoneyBounds_(sumRaw);
  var vehicleTo = insuranceNumber_(vehicle && vehicle.dltPriceTo);
  if (!sum || sum.min <= 0 || sum.max <= 0 || vehicleTo === null) return false;
  return sum.max <= vehicleTo;
}

function insuranceCustomerRepairLabel_(value) {
  var text = insuranceClean_(value);
  if (/ห้าง|ศูนย์|dealer/i.test(text)) return 'ซ่อมศูนย์บริการ';
  if (/อู่|garage/i.test(text)) return 'ซ่อมอู่';
  return text;
}

function insuranceVehicleGroup_(category, submodel) {
  var text = [category, submodel].join(' ');
  if (/กระบะตอนเดียว|กระบะแค็บ/i.test(text)) return 'รถกระบะ 2 ประตู';
  if (/กระบะ 4 ประตู|รถยนต์นั่งส่วนบุคคล|รถเก๋ง/i.test(text)) return 'รถเก๋ง/กระบะ 4 ประตู';
  if (/กระบะ|pickup/i.test(text)) return 'รถกระบะ';
  return insuranceClean_(category);
}

function insuranceGroupMatches_(expected, group, category, submodel) {
  if (/all|ทุก|ทั้งหมด/i.test(expected)) return true;
  var categoryText = [category, submodel].join(' ');
  if (/รถเก๋ง\s*\/\s*กระบะ|รถเก๋ง.*กระบะ/i.test(expected)) {
    return /รถยนต์นั่งส่วนบุคคล|รถเก๋ง|กระบะ|pickup/i.test(categoryText);
  }
  if (/รถกระบะ|pickup/i.test(expected)) return /กระบะ|pickup/i.test(categoryText);
  if (/รถตู้|van/i.test(expected)) return /รถตู้|van/i.test(categoryText);
  if (/รถจักรยานยนต์|motorcycle|big\s*bike/i.test(expected)) {
    return /จักรยานยนต์|motorcycle|big\s*bike/i.test(categoryText);
  }
  if (/รถบรรทุก|truck/i.test(expected)) return /บรรทุก|truck/i.test(categoryText);
  var expectedText = insuranceNormalizeText_(expected);
  var candidateText = insuranceNormalizeText_([group, category, submodel].join('|'));
  return insuranceListMatches_([group, category, submodel].join('|'), expected) ||
    candidateText.indexOf(expectedText) !== -1 || expectedText.indexOf(insuranceNormalizeText_(category)) !== -1;
}

function insuranceMakeGroupMatches_(expected, make, model) {
  if (/all_eligible|ทุกยี่ห้อ|ทุกบริษัท/i.test(expected)) return true;
  return expected.split(/[,|\/;\n]+/).some(function (token) {
    var parts = insuranceClean_(token).split(':');
    return insuranceSame_(parts[0], make) && (!parts[1] || insuranceSame_(parts.slice(1).join(':'), model));
  });
}

function insuranceTokenMatches_(list, value) {
  return insuranceClean_(list).split(/[,|\/;\n]+/).some(function (token) {
    return insuranceSame_(token, value) || /all|ทุก/i.test(token);
  });
}

function insuranceListMatches_(list, value) {
  var target = insuranceModificationKey_(value);
  return insuranceClean_(list).split(/[,|\/;\n]+/).some(function (token) {
    var item = insuranceClean_(token);
    return insuranceSame_(item, value) || (target !== 'other' && insuranceModificationKey_(item) === target);
  });
}

function insuranceValueListMatches_(list, values) {
  if (!insuranceClean_(list) || !insuranceClean_(values)) return false;
  var targets = insuranceClean_(values).split(/[,|\/;\n]+/).map(insuranceNormalizeText_).filter(Boolean);
  return insuranceClean_(list).split(/[,|\/;\n]+/).map(insuranceClean_).filter(Boolean).some(function (token) {
    var normalized = insuranceNormalizeText_(token);
    return targets.some(function (target) {
      return normalized === target || normalized.indexOf(target) !== -1 || target.indexOf(normalized) !== -1;
    });
  });
}

function insuranceModificationKey_(value) {
  var text = insuranceNormalizeText_(value);
  if (!text || /ไม่มี|ไม่ต่อเติม|none|standard/.test(text)) return 'none';
  if (/คอก|แซง|รั้ว|cage|fence|flatbed/.test(text)) return 'cage';
  if (/ตู้ทึบ|closedbox|closedbody/.test(text)) return 'closed';
  if (/ตู้แห้ง|drybox|drybody/.test(text)) return 'dry';
  return 'other';
}

function insuranceNormalizeText_(value) {
  return insuranceClean_(value).toLowerCase().replace(/[\s_\-\/().]+/g, '');
}

function insuranceNormalizeHeader_(value) {
  return insuranceNormalizeText_(value).replace(/[:：]/g, '');
}

function insuranceField_(row, names) {
  if (!row) return '';
  var alias = row._alias || {};
  for (var i = 0; i < names.length; i += 1) {
    var key = insuranceNormalizeHeader_(names[i]);
    if (Object.prototype.hasOwnProperty.call(alias, key)) return insuranceClean_(alias[key]);
  }
  return '';
}

function insuranceClean_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function insuranceSame_(a, b) {
  return insuranceNormalizeText_(a) === insuranceNormalizeText_(b);
}

function insuranceUnique_(values) {
  var seen = {};
  return (values || []).filter(function (value) {
    var text = insuranceClean_(value);
    var key = insuranceNormalizeText_(text);
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function insuranceThaiSort_(a, b) {
  return insuranceClean_(a).localeCompare(insuranceClean_(b), 'th');
}

function insuranceCreateQuoteId_() {
  return 'IQ' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMddHHmmss') +
    Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase();
}



function insuranceRepairClass_(v){var t=insuranceClean_(v);if(!t)return '';if(/ซ่อมห้าง|ห้าง|ศูนย์|dealer|ศูนย์บริการ/i.test(t))return 'ซ่อมห้าง';if(/ซ่อมอู่|อู่|garage|เครือข่าย|อู่ในสัญญา/i.test(t))return 'ซ่อมอู่';return '';}
function insuranceCustomerRepairLabel_(v){return insuranceRepairClass_(v)||insuranceClean_(v);}
function insuranceCampaignCurrent_(s,e){var n=new Date(),b=insuranceParseDate_(s),f=insuranceParseDate_(e);if(b)b.setHours(0,0,0,0);if(f)f.setHours(23,59,59,999);return(!b||n>=b)&&(!f||n<=f);}
function insuranceAgeCriteriaStatusUsable_(r){var s=insuranceClean_(insuranceField_(r,['status','สถานะ','สถานะข้อมูล'])).toUpperCase();return s==='VERIFIED'||s==='PARTIAL'||/ยืนยัน|บางส่วน/.test(s);}
function insuranceAgeCriteriaRangeMatches_(r,a){var mn=insuranceField_(r,['min_vehicle_age','min_age','อายุรถขั้นต่ำ','ขั้นต่ำอายุรถ']),mx=insuranceField_(r,['max_vehicle_age','max_age','อายุรถสูงสุด','สูงสุดอายุรถ']),lo=mn?insuranceNumber_(mn):null,hi=mx?insuranceNumber_(mx):null;if(lo===null&&hi===null)return false;return!(lo!==null&&a<lo)&&!(hi!==null&&a>hi);}
function insuranceAgeCriteriaVehicleMatches_(r,v){var e=insuranceField_(r,['vehicle_code','รหัสรถ','vehicle_id','รหัสรถยนต์']);if(!e||/all|ทุก|ทั้งหมด/i.test(e))return true;return[v&&v.rateVehicleCode,v&&v.vehicleId,insuranceField_(v&&v._row,['rate_vehicle_code','insurance_vehicle_code','vehicle_code','รหัสรถ','รหัสเรต'])].filter(Boolean).some(function(x){return insuranceTokenMatches_(e,x);});}
function insuranceAgeCriteriaUsageValuesMatches_(e,u){if(!e)return true;if(/all|ทุกประเภท|ทั้งหมด/i.test(e))return true;if(/^ตรวจเงื่อนไข$/i.test(insuranceClean_(e)))return false;return insuranceValueListMatches_(e,u);}
function insuranceAgeCriteriaPackageMatches_(r,rate,p){var a=insuranceField_(r,['package_name','ชื่อแพ็กเกจ','แพ็กเกจ','ชื่อแผน']);if(!a)return true;var b=insuranceField_(rate,['package_name','ชื่อแพ็กเกจ','แพ็กเกจ','ชื่อแผน'])||insuranceField_(p,['product_name','ชื่อผลิตภัณฑ์','ชื่อแพ็กเกจ','แพ็กเกจ','ชื่อแผน']);if(!b)return true;a=insuranceNormalizeText_(a);b=insuranceNormalizeText_(b);return a===b||a.indexOf(b)!==-1||b.indexOf(a)!==-1;}
function insuranceAgeMatches_(rate,p,y,rows){var yr=insuranceYear_(y);if(!yr)return false;var a=new Date().getFullYear()-yr;if(a<0)return false;var mn=insuranceField_(rate,['min_vehicle_age','min_age','อายุรถขั้นต่ำ','ขั้นต่ำอายุรถ']),mx=insuranceField_(rate,['max_vehicle_age','max_age','อายุรถสูงสุด','สูงสุดอายุรถ']),lo=mn?insuranceNumber_(mn):null,hi=mx?insuranceNumber_(mx):null;if(lo!==null&&a<lo||hi!==null&&a>hi)return false;var pid=insuranceField_(rate,['product_id','รหัสผลิตภัณฑ์'])||insuranceField_(p,['product_id','รหัสผลิตภัณฑ์']);var rs=(rows||[]).filter(function(r){return pid&&insuranceSame_(insuranceField_(r,['product_id','รหัสผลิตภัณฑ์']),pid)&&insuranceAgeCriteriaStatusUsable_(r)&&insuranceCampaignCurrent_(insuranceField_(r,['effective_from','เริ่มมีผล','วันเริ่มแคมเปญ']),insuranceField_(r,['effective_to','สิ้นสุดผล','วันสิ้นสุดแคมเปญ']));});if(!rs.length)return true;var typ=insuranceField_(rate,['insurance_type','ประเภทประกัน','ประเภทประกันภัย'])||insuranceField_(p,['insurance_type','ประเภทประกัน','ประเภทประกันภัย']),rep=insuranceRepairClass_(insuranceField_(rate,['repair_type','ประเภทการซ่อม','ซ่อมอู่/ซ่อมห้าง'])||insuranceField_(p,['repair_type','ประเภทการซ่อม','ซ่อมอู่/ซ่อมห้าง']));return rs.some(function(r){var rt=insuranceField_(r,['insurance_type','ประเภทประกัน','ประเภทประกันภัย']),rr=insuranceRepairClass_(insuranceField_(r,['repair_type','repair_type_source','ประเภทการซ่อม','ซ่อมอู่/ซ่อมห้าง']));return(!rt||insuranceTypeMatches_(rt,typ))&&insuranceAgeCriteriaPackageMatches_(r,rate,p)&&(!rr||rep&&rr===rep)&&insuranceAgeCriteriaRangeMatches_(r,a);});}
function insuranceTypeOneRows_(n,v,s){var yr=insuranceYear_(n.vehicleYear),a=yr?new Date().getFullYear()-yr:-1;if(a<0)return [];return(s.ageRows||[]).map(function(r){if(!insuranceAgeCriteriaStatusUsable_(r)||!insuranceAgeCriteriaRangeMatches_(r,a))return null;var pid=insuranceField_(r,['product_id','รหัสผลิตภัณฑ์']),p=insuranceFindById_(s.products,pid);if(!p||!insuranceIsActive_(p))return null;var rt=insuranceField_(r,['insurance_type','ประเภทประกัน','ประเภทประกันภัย'])||insuranceField_(p,['insurance_type','ประเภทประกัน','ประเภทประกันภัย']);if(!insuranceTypeMatches_(rt,'1'))return null;if(!insuranceCampaignCurrent_(insuranceField_(p,['campaign_start','วันเริ่มแคมเปญ']),insuranceField_(p,['campaign_end','วันสิ้นสุดแคมเปญ']))||!insuranceCampaignCurrent_(insuranceField_(r,['effective_from','เริ่มมีผล','วันเริ่มแคมเปญ']),insuranceField_(r,['effective_to','สิ้นสุดผล','วันสิ้นสุดแคมเปญ'])))return null;if(!insuranceAgeCriteriaVehicleMatches_(r,v))return null;var u=insuranceField_(r,['usage_type','ลักษณะการใช้งาน','การใช้งาน','vehicle_use'])||insuranceField_(p,['usage_type','ลักษณะการใช้งาน','การใช้งาน','vehicle_use']);if(!insuranceAgeCriteriaUsageValuesMatches_(u,n.usageType)||!insuranceAgeCriteriaPackageMatches_(r,null,p))return null;var rep=insuranceRepairClass_(insuranceField_(r,['repair_type','repair_type_source','ประเภทการซ่อม','ซ่อมอู่/ซ่อมห้าง'])||insuranceField_(p,['repair_type','ประเภทการซ่อม','ซ่อมอู่/ซ่อมห้าง']));if(!rep||n.repairType&&insuranceRepairClass_(n.repairType)!==rep)return null;var ins=insurancePublicInsurerName_(insuranceField_(r,['insurer_name','ชื่อบริษัท','บริษัท'])||insuranceField_(p,['insurer_name','ชื่อบริษัท','บริษัท']));return ins?{product:p,row:r,repairType:rep,insurer:ins}:null;}).filter(Boolean);}
function insuranceTypeOneOptions_(n,v,s){var g={'ซ่อมอู่':[],'ซ่อมห้าง':[]};insuranceTypeOneRows_(n,v,s).forEach(function(x){if(n.preferredInsurers.length&&!insurancePreferredInsurerMatches_(n.preferredInsurers,x.insurer))return;if(g[x.repairType]&&g[x.repairType].indexOf(x.insurer)<0)g[x.repairType].push(x.insurer);});return['ซ่อมอู่','ซ่อมห้าง'].filter(function(r){return g[r].length;}).map(function(r){var names=g[r].sort(insuranceThaiSort_);return{value:'1|'+r+'|'+names.join('~'),label:'ประเภท 1 '+r,staffOnly:true,repairType:r,eligibleInsurers:names};});}
function webGetInsuranceCoverageOptions(input){var n=insuranceNormalizeInput_(input||{}),out=webGetInsuranceCoverageOptionsOriginal_(input||{});out.options=(out.options||[]).filter(function(o){return insuranceNormalizeType_(String(o.value||'').split('|')[0])!=='1';});if(!n.vehicleId||!n.vehicleYear||!n.registrationProvince||!n.usageType)return out;var s=insuranceLoadSnapshot_(),v=insuranceResolveVehicle_(n,s.vehicles,s.priceRows);if(!v.ok)return out;out.options=insuranceTypeOneOptions_(n,v.value,s).concat(out.options);out.message=out.options.length?'':'ยังไม่พบประเภทประกันภัยที่ตรงกับข้อมูลรถ';return out;}
function webFindInsuranceQuotes(input){var rawInput=input||{},rawCoverage=insuranceClean_(rawInput.coverageType||rawInput.insurance_type),parts=rawCoverage.split('|');if(parts[0]==='1'&&parts[1])rawInput=Object.assign({},rawInput,{coverageType:'1',repairType:parts[1]});var n=insuranceNormalizeInput_(rawInput),qid=insuranceCreateQuoteId_();if(n.coverageType!=='1')return webFindInsuranceQuotesOriginal_(input||{});if(n.insuranceType!=='motor')return insuranceStaffResult_(qid,'ประกันภัยรถยนต์เท่านั้น','กรุณาใช้ข้อมูลในหน้านี้สำหรับประกันภัยรถยนต์');if(!n.vehicleId||!n.vehicleYear||!n.registrationProvince||!n.usageType)return insuranceVerifyResult_(qid,'กรุณาเลือกข้อมูลรถ ปีรถ จังหวัดที่จดทะเบียนรถ และลักษณะการใช้งานรถให้ครบถ้วน');var s=insuranceLoadSnapshot_(),v=insuranceResolveVehicle_(n,s.vehicles,s.priceRows),rep=insuranceRepairClass_(n.repairType);if(!v.ok)return insuranceVerifyResult_(qid,'ไม่พบข้อมูลรถที่ตรงกับรายการที่เลือก');if(!rep)return insuranceVerifyResult_(qid,'กรุณาเลือกประเภท 1 เป็นซ่อมอู่หรือซ่อมห้าง');var rows=insuranceTypeOneRows_(n,v.value,s).filter(function(x){return x.repairType===rep&&(!n.preferredInsurers.length||insurancePreferredInsurerMatches_(n.preferredInsurers,x.insurer));});if(!rows.length){var no=insuranceVerifyResult_(qid,'ยังไม่พบบริษัทที่รับประเภท 1 '+rep+' สำหรับอายุรถและข้อมูลรถนี้');no.repairType=rep;insuranceLogCheck_(n,qid,no.status,no.message,null,v);return no;}var names=insuranceUnique_(rows.map(function(x){return x.insurer;})).sort(insuranceThaiSort_),res=insuranceStaffResult_(qid,'ประเภท 1 '+rep+' — เจ้าหน้าที่ตรวจสอบและเสนอราคาเบี้ยประกันภัย','บริษัทที่มีเกณฑ์อายุรถตรงเบื้องต้น: '+names.join(', ')+' ทั้งนี้ประเภท 1 เป็นการเสนอราคาโดยเจ้าหน้าที่และต้องตรวจสอบเงื่อนไขกรมธรรม์ก่อนยืนยัน');res.preferredInsurers=n.preferredInsurers;res.repairType=rep;res.eligibleInsurers=names;res.vehicle=v.public;insuranceLogCheck_(n,qid,res.status,res.message,null,v);return res;}
