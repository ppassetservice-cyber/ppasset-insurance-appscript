/** LINE integration for insurance quote request TEST only. */
var PP_QUOTE_LINE = {
  loginChannelId: '2011333776',
  messagingChannelId: '2011333622',
  oaId: '@pp.asset'
};

function insuranceQuoteLineConfig_() {
  var props = PropertiesService.getScriptProperties();
  return {
    loginChannelId: PP_QUOTE_LINE.loginChannelId,
    messagingChannelId: PP_QUOTE_LINE.messagingChannelId,
    oaId: PP_QUOTE_LINE.oaId,
    liffId: props.getProperty('INSURANCE_TEST_LIFF_ID') || '',
    liffUrl: props.getProperty('INSURANCE_TEST_LIFF_URL') || '',
    accessToken: props.getProperty('INSURANCE_TEST_LINE_ACCESS_TOKEN') || '',
    sendEnabled: props.getProperty('INSURANCE_TEST_LINE_SEND_ENABLED') === 'true'
  };
}

function insuranceQuoteLineSetupStatus() {
  var config = insuranceQuoteLineConfig_();
  var status = {
    loginChannelId: config.loginChannelId,
    messagingChannelId: config.messagingChannelId,
    oaId: config.oaId,
    hasLiffId: Boolean(config.liffId),
    hasLiffUrl: Boolean(config.liffUrl),
    hasAccessToken: Boolean(config.accessToken),
    sendEnabled: config.sendEnabled
  };
  console.log(JSON.stringify(status));
  return status;
}

function insuranceQuoteLineCheckBot() {
  var config = insuranceQuoteLineConfig_();
  if (!config.accessToken) throw new Error('ยังไม่ได้ตั้งค่าโทเคน');
  var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    method: 'get',
    headers: {Authorization: 'Bearer ' + config.accessToken.trim()},
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  if (code !== 200) throw new Error('ตรวจโทเคนไม่ผ่าน HTTP ' + code);
  var bot = JSON.parse(response.getContentText());
  var status = {
    ok: bot.premiumId === config.oaId,
    basicId: bot.basicId || '',
    premiumId: bot.premiumId || '',
    displayName: bot.displayName || '',
    sendEnabled: config.sendEnabled
  };
  console.log(JSON.stringify(status));
  return status;
}
