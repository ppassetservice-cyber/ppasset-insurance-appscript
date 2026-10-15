/** Insurance Office notification: TEST only.
 * Call while the quote submission holds the script lock.
 */
function insuranceQuoteOfficeNotifyLocked_(requestId) {
  var row;
  try {
    var props = PropertiesService.getScriptProperties();
    var config = insuranceQuoteLineTestGuard_();
    row = insuranceQuoteLineRow_(requestId);
    if (row.data.staff_notification_status === 'ACCEPTED') {
      return {ok:true, status:'ACCEPTED', duplicate:true};
    }
    if (props.getProperty('INSURANCE_TEST_LINE_GROUP_SEND_ENABLED') !== 'true') {
      return {ok:false, status:'PENDING_TEST_DISABLED'};
    }

    var groupId = String(props.getProperty('INSURANCE_TEST_LINE_GROUP_ID') || '').trim();
    if (groupId !== 'C214be6ed1cd4aa5e7f7713905faf3044') {
      throw new Error('GROUP_CONFIG');
    }
    if (!config.accessToken) throw new Error('TOKEN_CONFIG');

    var auth = {Authorization:'Bearer ' + config.accessToken.trim()};
    var botResponse = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
      headers:auth, muteHttpExceptions:true
    });
    if (botResponse.getResponseCode() !== 200 ||
        JSON.parse(botResponse.getContentText()).premiumId !== '@pp.asset') {
      throw new Error('OA_MISMATCH');
    }

    // Keep the destination, body and retry key fixed across retries.
    var stateKey = 'INSURANCE_OFFICE_PUSH_' + requestId;
    var raw = props.getProperty(stateKey);
    var state = raw ? JSON.parse(raw) : null;
    if (!state) {
      var d = row.data;
      var text = [
        'TEST — คำขอเช็กเบี้ยประกันใหม่',
        'เลขที่คำขอ: ' + d.request_id,
        'ชื่อ: ' + d.customer_name,
        'โทร: ' + d.customer_phone,
        'ประเภทรถ: ' + d.vehicle_category,
        'รถ: ' + d.vehicle_make + ' ' + d.vehicle_model,
        'รุ่นย่อย: ' + d.vehicle_submodel,
        'ปีจดทะเบียน: ' + d.registration_year,
        'จังหวัด: ' + d.registration_province,
        'การใช้งาน: ' + d.usage_type,
        'การดัดแปลง: ' + (d.modification || 'ไม่ระบุ'),
        'ประกันประเภท: ' + d.insurance_type,
        'การซ่อม: ' + (d.repair_type || 'ไม่ระบุ'),
        'บริษัทที่สนใจ: ' + d.preferred_insurers,
        'หมายเหตุ: ' + (d.contact_note || '-'),
        'กรุณาตรวจสอบและจัดทำข้อเสนอเบี้ยประกัน',
        'https://docs.google.com/spreadsheets/d/' + PP_QUOTE_REQUEST.spreadsheetId
      ].join('\n');
      if (text.length > 5000) throw new Error('MESSAGE_TOO_LONG');
      state = {
        groupId:groupId,
        retryKey:Utilities.getUuid(),
        body:JSON.stringify({to:groupId, messages:[{type:'text', text:text}]})
      };
      props.setProperty(stateKey, JSON.stringify(state));
    }
    if (state.groupId !== groupId) throw new Error('DESTINATION_CHANGED');

    insuranceQuoteLineSet_(row, 'staff_notification_status', 'PENDING_RETRY');
    SpreadsheetApp.flush();
    var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method:'post', contentType:'application/json',
      headers:{
        Authorization:auth.Authorization,
        'X-Line-Retry-Key':state.retryKey
      },
      payload:state.body, muteHttpExceptions:true
    });
    var code = response.getResponseCode();
    var accepted = code === 200;
    if (code === 409) {
      var responseHeaders = response.getAllHeaders();
      accepted = Object.keys(responseHeaders).some(function(k) {
        return k.toLowerCase() === 'x-line-accepted-request-id' &&
          Boolean(responseHeaders[k]);
      });
    }
    var status = accepted ? 'ACCEPTED' : 'FAILED_HTTP_' + code;
    insuranceQuoteLineSet_(row, 'staff_notification_status', status);
    insuranceQuoteLineSet_(row, 'updated_at', new Date().toISOString());
    SpreadsheetApp.flush();
    // Remove persisted message data only after the accepted status is saved.
    if (accepted) props.deleteProperty(stateKey);
    return {ok:accepted, status:status};
  } catch (error) {
    if (row) {
      try {
        insuranceQuoteLineSet_(row, 'staff_notification_status', 'PENDING_RETRY');
        SpreadsheetApp.flush();
      } catch (_) {}
    }
    return {ok:false, status:'PENDING_RETRY'};
  }
}
