var express = require('express');
var moment = require('moment');
var http = require('http');
var request = require('request');
var fs = require('fs');
var path = require('path');
var Q = require('q');
var cors = require('cors');

var app = express();
var port = process.env.PORT || 3708;
var baseDir = 'http://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl';

// cors config
var whitelist = [
  'http://localhost:63342',
  'http://localhost:3000',
  'http://localhost:4000',
  'http://localhost:3707',
  'http://danwild.github.io',
];

var corsOptions = {
  origin: function (origin, callback) {
    var originIsWhitelisted = whitelist.indexOf(origin) !== -1;
    callback(null, originIsWhitelisted);
  },
};

app.listen(port, function (err) {
  console.log('running server on port ' + port);
});

app.get('/wind', cors(corsOptions), function (req, res) {
  res.send('hello wind-js-server.. go to /latest for wind data..');
});

app.get('/wind/alive', cors(corsOptions), function (req, res) {
  res.send('wind-js-server is alive');
});

app.get('/wind/latest', cors(corsOptions), function (req, res) {
  /**
   * Find and return the latest available 6 hourly pre-parsed JSON data
   *
   * @param targetMoment {Object} UTC moment
   */
  function sendLatest(targetMoment) {
    var stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);
    var fileName = __dirname + '/json-data/' + stamp + '.json';

    res.setHeader('Content-Type', 'application/json');
    res.sendFile(fileName, {}, function (err) {
      if (err) {
        console.log(stamp + ' doesnt exist yet, trying previous interval..');
        sendLatest(moment(targetMoment).subtract(6, 'hours'));
      }
    });
  }

  sendLatest(moment().utc());
});

app.get('/wind/nearest', cors(corsOptions), function (req, res, next) {
  const time = req.query.timeIso;
  const limit = parseInt(req.query.searchLimit) || 1; // 默认值设为 1
  let searchForwards = false;

  function sendNearestTo(targetMoment) {
    // 精确到小时判断是否超出限制
    const hoursDiff = Math.abs(moment.utc(time).diff(targetMoment, 'hours'));
    if (limit && hoursDiff >= limit * 24) {
      if (!searchForwards) {
        searchForwards = true;
        // 从初始时间开始向前搜索
        sendNearestTo(moment.utc(time).add(limit * 24, 'hours'));
        return;
      } else {
        return next(new Error('No data within searchLimit'));
      }
    }

    const roundedHour = roundHours(targetMoment.hour(), 6);
    const stamp = targetMoment.format('YYYYMMDD') + roundedHour.toString().padStart(2, '0');
    const fileName = path.join(__dirname, 'json-data', `${stamp}.json`);

    res.sendFile(fileName, (err) => {
      if (err) {
        const nextTarget = searchForwards
          ? targetMoment.clone().add(6, 'hours')
          : targetMoment.clone().subtract(6, 'hours');
        sendNearestTo(nextTarget);
      }
    });
  }

  if (time && moment.utc(time).isValid()) {
    sendNearestTo(moment.utc(time));
  } else {
    next(new Error('Invalid timeIso'));
  }
});

/**
 *
 * Ping for new data every 15 mins
 *
 */
setInterval(function () {
  run(moment.utc());
}, 900000);

/**
 *
 * @param targetMoment {Object} moment to check for new data
 */
function run(targetMoment) {
  getGribData(targetMoment).then(function (response) {
    if (response.stamp) {
      convertGribToJson(response.stamp, response.targetMoment);
    }
  });
}

/**
 *
 * Finds and returns the latest 6 hourly GRIB2 data from NOAAA
 *
 * @returns {*|promise}
 */
function getGribData(targetMoment) {
  var deferred = Q.defer();

  function runQuery(targetMoment) {
    // only go 2 weeks deep
    if (moment.utc().diff(targetMoment, 'days') > 30) {
      console.log('hit limit, harvest complete or there is a big gap in data..');
      return;
    }

    var stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);
    var urlstamp = stamp.slice(0, 8) + '/' + stamp.slice(8, 10) + '/atmos';

    request
      .get({
        url: baseDir,
        qs: {
          file: 'gfs.t' + roundHours(moment(targetMoment).hour(), 6) + 'z.pgrb2.1p00.f000',
          lev_10_m_above_ground: 'on',
          lev_surface: 'on',
          var_TMP: 'on',
          var_UGRD: 'on',
          var_VGRD: 'on',
          leftlon: 0,
          rightlon: 360,
          toplat: 90,
          bottomlat: -90,
          dir: '/gfs.' + urlstamp,
        },
      })
      .on('error', function (err) {
        // console.log(err);
        runQuery(moment(targetMoment).subtract(6, 'hours'));
      })
      .on('response', function (response) {
        console.log('response ' + response.statusCode + ' | ' + stamp);

        if (response.statusCode != 200) {
          runQuery(moment(targetMoment).subtract(6, 'hours'));
        } else {
          // don't rewrite stamps
          if (!checkPath('json-data/' + stamp + '.json', false)) {
            console.log('piping ' + stamp);

            // mk sure we've got somewhere to put output
            checkPath('grib-data', true);

            // pipe the file, resolve the valid time stamp
            var file = fs.createWriteStream('grib-data/' + stamp + '.f000');
            response.pipe(file);
            file.on('finish', function () {
              file.close();
              deferred.resolve({ stamp: stamp, targetMoment: targetMoment });
            });
          } else {
            console.log('already have ' + stamp + ', not looking further');
            deferred.resolve({ stamp: false, targetMoment: false });
          }
        }
      });
  }

  runQuery(targetMoment);
  return deferred.promise;
}

function convertGribToJson(stamp, targetMoment) {
  // mk sure we've got somewhere to put output
  checkPath('json-data', true);

  var exec = require('child_process').exec,
    child;

  child = exec(
    'converter/bin/grib2json --data --output json-data/' +
      stamp +
      '.json --names --compact grib-data/' +
      stamp +
      '.f000',
    { maxBuffer: 500 * 1024 },
    function (error, stdout, stderr) {
      if (error) {
        console.log('exec error: ' + error);
      } else {
        console.log('converted..');

        // don't keep raw grib data
        exec('rm grib-data/*');

        // if we don't have older stamp, try and harvest one
        var prevMoment = moment(targetMoment).subtract(6, 'hours');
        var prevStamp = prevMoment.format('YYYYMMDD') + roundHours(prevMoment.hour(), 6);

        if (!checkPath('json-data/' + prevStamp + '.json', false)) {
          console.log('attempting to harvest older data ' + stamp);
          run(prevMoment);
        } else {
          console.log('got older, no need to harvest further');
        }
      }
    },
  );
}

/**
 *
 * Round hours to expected interval, e.g. we're currently using 6 hourly interval
 * i.e. 00 || 06 || 12 || 18
 *
 * @param hours
 * @param interval
 * @returns {String}
 */
function roundHours(hours, interval) {
  if (interval > 0) {
    var result = Math.floor(hours / interval) * interval;
    return result < 10 ? '0' + result.toString() : result;
  }
}

/**
 * Sync check if path or file exists
 *
 * @param path {string}
 * @param mkdir {boolean} create dir if doesn't exist
 * @returns {boolean}
 */
function checkPath(path, mkdir) {
  try {
    fs.statSync(path);
    return true;
  } catch (e) {
    if (mkdir) {
      fs.mkdirSync(path);
    }
    return false;
  }
}

// init harvest
run(moment.utc());
