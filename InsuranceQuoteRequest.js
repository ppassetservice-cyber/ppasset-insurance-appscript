/** Manual insurance quote requests. */
var PP_QUOTE_REQUEST = {
  spreadsheetId: '1XiknAuU9jOuWA2OiA3hcbrCot3PlV6tM5M59S8cf_Gg',
  sheetName: 'Insurance_Quote_Requests',
  privacyVersion: 'quote-request-v1-2026-10-08',
  headers: ['request_id','created_at','request_status','customer_name','customer_phone','line_user_id','line_display_name','line_link_status','vehicle_id','vehicle_category','vehicle_make','vehicle_model','vehicle_submodel','vehicle_year','registration_year','registration_province','usage_type','modification','insurance_type','repair_type','preferred_insurers','contact_note','consent','consent_at','privacy_notice_version','source_host','source_channel','submission_key','customer_receipt_status','staff_notification_status','updated_at']
};
function webGetQuoteRequestOptions() {
  var book = SpreadsheetApp.openById(PP_QUOTE_REQUEST.spreadsheetId);
  var vehicles = insuranceReadRows_(book, ['Vehicle_Master']).map(insuranceVehicleOption_).filter(function(v){return v.category && v.make && v.model;});
  var companies = insurancePublicCompanies_({companies:insuranceReadRows_(book,['Company_Index']),products:[]});
  var provinces = insuranceUnique_(insuranceReadRows_(book,['Province_Criteria']).map(function(r){return insuranceField_(r,['province_name','จังหวัด','จังหวัดที่จดทะเบียน']);}).filter(Boolean)).sort(insuranceThaiSort_);
  if (!companies.length || !provinces.length || !vehicles.length) throw new Error('ยังเตรียมรายการแบบฟอร์มไม่ครบ กรุณาลองใหม่');
  return {ok:true,vehicles:vehicles.map(function(v){return {vehicleId:v.vehicleId,category:v.category,make:v.make,model:v.model,submodel:v.submodel,yearMin:v.yearMin,yearMax:v.yearMax};}),vehicleCategories:insuranceUnique_(vehicles.map(function(v){return v.category;})),companies:companies.map(function(c){return c.name;}),provinces:provinces,usageTypes:PP_INSURANCE_USAGE_TYPES,modifications:PP_INSURANCE_MODIFICATIONS,coverageTypes:PP_INSURANCE_COVERAGE_TYPES,privacyVersion:PP_QUOTE_REQUEST.privacyVersion};
}
/** Caller must hold the script lock. Reserve numbers before writing rows. */
function insuranceQuoteNextShortIdLocked_(sheet, headers) {
  var props = PropertiesService.getScriptProperties();
  var counterKey = 'INS_QUOTE_SEQ_' + PP_QUOTE_REQUEST.spreadsheetId + '_' + PP_QUOTE_REQUEST.sheetName;
  var saved = props.getProperty(counterKey);
  if (saved !== null && !/^\d+$/.test(saved)) throw new Error('ตัวนับเลขลีดไม่ถูกต้อง กรุณาติดต่อเจ้าหน้าที่');
  var maxId = Number(saved || 0), last = sheet.getLastRow();
  if (last > 1) {
    sheet.getRange(2, headers.indexOf('request_id') + 1, last - 1, 1).getDisplayValues().forEach(function(r) {
      var match = /^INS(\d{6,})$/.exec(r[0]);
      if (match) maxId = Math.max(maxId, Number(match[1]));
    });
  }
  if (!Number.isSafeInteger(maxId) || maxId >= Number.MAX_SAFE_INTEGER) throw new Error('ตัวนับเลขลีดเกินขอบเขต กรุณาติดต่อเจ้าหน้าที่');
  var next = maxId + 1;
  props.setProperty(counterKey, String(next));
  return 'INS' + String(next).padStart(6, '0');
}
function webSubmitInsuranceQuoteRequest(payload) {
  payload = payload || {};
  function clean(key,max){var s=String(payload[key] == null ? '' : payload[key]).trim();if(s.length>max)throw new Error('ข้อมูลยาวเกินกำหนด: '+key);return s;}
  try {
    var name=clean('customer_name',120),phone=clean('customer_phone',20).replace(/[\s-]/g,''),key=clean('submission_key',80);
    if(name.length<2 || !/^0\d{8,9}$/.test(phone))throw new Error('กรุณาตรวจสอบชื่อและเบอร์โทรศัพท์');
    if(payload.consent!==true)throw new Error('กรุณายินยอมให้ใช้ข้อมูลเพื่อดำเนินการเช็กเบี้ย');
    if(!/^[a-zA-Z0-9_-]{16,80}$/.test(key))throw new Error('รหัสการส่งไม่ถูกต้อง กรุณาโหลดหน้าใหม่');
    var values={},required=['vehicle_category','vehicle_make','vehicle_model','vehicle_submodel','registration_province','usage_type','insurance_type'];
    required.forEach(function(k){values[k]=clean(k,200);if(!values[k])throw new Error('กรุณากรอกข้อมูลรถและประเภทประกันให้ครบ');});
    if(['1','2+','3+','3'].indexOf(values.insurance_type)<0)throw new Error('ประเภทประกันไม่ถูกต้อง');
    var year=Number(payload.registration_year),current=Number(Utilities.formatDate(new Date(),'Asia/Bangkok','yyyy'));
    if(!Number.isInteger(year)||year<1950||year>current+1)throw new Error('กรุณาตรวจสอบปีจดทะเบียน (ค.ศ.)');
    var options=webGetQuoteRequestOptions();
    if(options.provinces.indexOf(values.registration_province)<0 || options.usageTypes.indexOf(values.usage_type)<0)throw new Error('จังหวัดหรือลักษณะการใช้งานไม่ถูกต้อง');
    var vehicleId=clean('vehicle_id',80);
    if(!options.vehicles.some(function(v){return v.vehicleId===vehicleId && v.category===values.vehicle_category && v.make===values.vehicle_make && v.model===values.vehicle_model && (v.submodel||'รุ่นมาตรฐาน')===values.vehicle_submodel;}))throw new Error('ข้อมูลรถไม่ตรงกับรายการ กรุณาเลือกข้อมูลรถใหม่');
    var preferred=payload.preferred_insurers;
    if(!Array.isArray(preferred)||!preferred.length||preferred.length>3)throw new Error('กรุณาเลือกบริษัท หรือเลือกไม่ระบุ');
    preferred=insuranceUnique_(preferred.map(function(s){return String(s).trim();}));
    if(preferred.indexOf('ไม่ระบุ')>=0 && preferred.length!==1)throw new Error('เลือกไม่ระบุ หรือบริษัทที่ต้องการอย่างใดอย่างหนึ่ง');
    if(preferred.some(function(s){return s!=='ไม่ระบุ'&&options.companies.indexOf(s)<0;}))throw new Error('รายการบริษัทไม่ถูกต้อง กรุณาโหลดรายการใหม่');
    var book=SpreadsheetApp.openById(PP_QUOTE_REQUEST.spreadsheetId),sheet=book.getSheetByName(PP_QUOTE_REQUEST.sheetName);
    if(!sheet)throw new Error('ไม่พบที่เก็บคำขอ กรุณาติดต่อเจ้าหน้าที่');
    var headers=sheet.getRange(1,1,1,sheet.getLastColumn()).getDisplayValues()[0];
    if(headers.length!==PP_QUOTE_REQUEST.headers.length||headers.some(function(h,i){return h!==PP_QUOTE_REQUEST.headers[i];}))throw new Error('โครงสร้างรับคำขอไม่ตรง กรุณาติดต่อเจ้าหน้าที่');
    var lock=LockService.getScriptLock();
    if(!lock.tryLock(10000))throw new Error('ระบบกำลังรับคำขออื่น กรุณาลองใหม่');
    try {
      var keyColumn=headers.indexOf('submission_key')+1,last=sheet.getLastRow();
      if(last>1){var keys=sheet.getRange(2,keyColumn,last-1,1).getDisplayValues();for(var i=0;i<keys.length;i++){if(keys[i][0]===key){var existing=sheet.getRange(i+2,1,1,headers.length).getDisplayValues()[0];if(existing[headers.indexOf('customer_phone')]!==phone||existing[headers.indexOf('customer_name')]!==name)throw new Error('รหัสคำขอนี้ถูกใช้แล้ว กรุณาเริ่มคำขอใหม่');var duplicateOffice=insuranceQuoteOfficeNotifyLocked_(existing[0]);return {ok:true,requestId:existing[0],duplicate:true,staffNotification:duplicateOffice,message:'ระบบได้รับคำขอนี้แล้ว เจ้าหน้าที่จะติดต่อกลับเพื่อเสนอราคา'};}}}
      var now=new Date().toISOString(),id=insuranceQuoteNextShortIdLocked_(sheet,headers);
      Object.assign(values,{request_id:id,created_at:now,updated_at:now,request_status:'QUOTE_REQUESTED',customer_name:name,customer_phone:phone,vehicle_id:clean('vehicle_id',80),registration_year:String(year),vehicle_year:String(year),preferred_insurers:preferred.join(', '),repair_type:clean('repair_type',80),modification:clean('modification',200),contact_note:clean('contact_note',2000),consent:'TRUE',consent_at:now,privacy_notice_version:PP_QUOTE_REQUEST.privacyVersion,source_host:'TEST_APPS_SCRIPT',source_channel:'INSURANCE_QUOTE_REQUEST_V1',submission_key:key,line_link_status:'NOT_LINKED',customer_receipt_status:'NOT_SENT',staff_notification_status:'PENDING'});
      var row=headers.map(function(h){var v=values[h]||'';return /^[=+@-]/.test(String(v)) ? "'"+v : v;});
      var target=sheet.getRange(sheet.getLastRow()+1,1,1,headers.length);
      target.setNumberFormat('@');target.setValues([row]);SpreadsheetApp.flush();
      var stored=target.getDisplayValues()[0];
      if(stored[0]!==id || stored[keyColumn-1]!==key)throw new Error('ยังยืนยันการบันทึกไม่ได้ กรุณาลองส่งอีกครั้งด้วยข้อมูลเดิม');
      var officeResult=insuranceQuoteOfficeNotifyLocked_(id);return {ok:true,requestId:id,staffNotification:officeResult,message:'ได้รับคำขอเช็กเบี้ยแล้ว เจ้าหน้าที่จะติดต่อกลับเพื่อเสนอราคา'};
    } finally {lock.releaseLock();}
  } catch(error){return {ok:false,message:error&&error.message?error.message:'ส่งคำขอไม่สำเร็จ กรุณาลองใหม่'};}
}