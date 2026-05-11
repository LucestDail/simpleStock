function formatError(error) {
  if (!error) return null;
  return {
    message: error.message || String(error),
    stack: error.stack || '',
  };
}

function writeLog(level, event, context = {}) {
  const payload = {
    at: new Date().toISOString(),
    level,
    event,
    ...context,
  };

  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function logInfo(event, context = {}) {
  writeLog('info', event, context);
}

function logWarn(event, context = {}) {
  writeLog('warn', event, context);
}

function logError(event, error, context = {}) {
  writeLog('error', event, {
    ...context,
    error: formatError(error),
  });
}

module.exports = {
  logInfo,
  logWarn,
  logError,
};
