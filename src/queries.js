const Influx = require('influx')
const { metrics } = require('./metrics')

// how much time to skip when looking for the historic max value of a metric
const MAX_GRACE_PERIOD = "7d"

const influx = new Influx.InfluxDB({
  host: process.env.INFLUX_HOST || 'influxdb',
  port: process.env.INFLUX_PORT || '8086'
})

const query = async (metricSpec) => {
  const { name, measurement, field, database } = metricSpec

  const metricsQuery = `SELECT "url", "time", "${field}" AS "value" FROM "${measurement}" WHERE time >= now() - 1d GROUP BY "url" ORDER BY "time" DESC LIMIT 1`
  const maxQuery = `SELECT max("${field}") AS "value" FROM "${measurement}" WHERE time <= now() - ${MAX_GRACE_PERIOD} GROUP BY "url" fill(none) ORDER BY time DESC LIMIT 1`
  // last 30 days - should we add `LIMIT 30` ?
  const monthSeriesQuery = `SELECT mean("${field}") AS "value" FROM "${measurement}" WHERE time >= now() - 30d GROUP BY time(1d), "url" fill(-1) ORDER BY time ASC`
  // last 365 days
  const yearSeriesQuery = `SELECT mean("${field}") AS "value" FROM "${measurement}" WHERE time >= now() - 365d GROUP BY time(7d), "url" fill(-1) ORDER BY time ASC`

  const [ metricsRows, maxRows, monthSeriesRows, yearSeriesRows ] = await Promise.all([
    influx.query(metricsQuery, { database }),
    influx.query(maxQuery, { database }),
    influx.query(monthSeriesQuery, { database }),
    influx.query(yearSeriesQuery, { database })
  ]).catch((e) => {
    console.error(e);
    return [[], [], [], []];
  })

  const maxValues = {}
  for (const row of maxRows) {
    maxValues[row.url] = {
      max: row.value,
      maxTime: (row.time.toISOString() || "").substr(0, 10),
    }
  }

  const monthSeriesValues = new Object()
  for (const row of monthSeriesRows) {
    if (!monthSeriesValues[row.url]) {
      monthSeriesValues[row.url] = []
    }
    monthSeriesValues[row.url].push(row.value)
  }

  const yearSeriesValues = new Object()
  for (const row of yearSeriesRows) {
    if (!yearSeriesValues[row.url]) {
      yearSeriesValues[row.url] = []
    }
    yearSeriesValues[row.url].push(row.value);
  }

  const data = {}
  for (const { url, value } of metricsRows) {
    const { max, maxTime } = maxValues[url] || {}
    const monthSeries = monthSeriesValues[url] || []
    const yearSeries = yearSeriesValues[url] || []
    data[url] = { value, max, maxTime, monthSeries, yearSeries }
  }

  return data
}

const median = (values) => {
  values.sort((a, b) => a - b)
  if (!values.length > 0) return null
  const half = Math.floor(values.length / 2)
  if (values.length % 2) return values[half]
  return Math.round((values[half - 1] + values[half]) / 2)
}

const fillCheckList = (series, checkList) => {
  for (let i = 0; i < series.length; i++) {
    if (checkList.length <= i) {
      checkList.push(0);
    }
    if (series[i] >= 0) {
      checkList[i]++;
    }
  }
  return checkList;
}

const getData = async () => {
  const results = await Promise.all(metrics.map((metric) => query(metric)))
  const metricResults = {}
  metrics.forEach((metric, i) => metricResults[metric.name] = results[i])

  const urlMap = {}

  for (const metric of metrics) {
    const results = metricResults[metric.name]
    for (const url of Object.keys(results)) {
      const row = urlMap[url] || { url, metrics: {}, score: 0, checks: 0, checkListMonth: [], checkListYear: [] }
      urlMap[url] = row
      const result = results[url]
      row.metrics[metric.name] = {
        value: Math.round(result.value),
        max: Math.round(result.max),
        maxTime: result.maxTime,
        monthSeries: result.monthSeries,
        yearSeries: result.yearSeries
      }

      row.checkListMonth = fillCheckList(result.monthSeries, row.checkListMonth);
      row.checkListYear = fillCheckList(result.yearSeries, row.checkListYear);
      
      row.metrics[metric.name].monthSeries = result.monthSeries.filter(val => val >= 0);
      row.metrics[metric.name].yearSeries = result.yearSeries.filter(val => val >= 0);

      row.score += result.value
      row.checks += 1
    }
  }

  for (let url in urlMap) {
    urlMap[url].checkListMonth = urlMap[url].checkListMonth.map(x=>x*5);
    urlMap[url].checkListYear = urlMap[url].checkListYear.map(x=>x*5);
  }

  const rv = Object.values(urlMap)
  for (const row of rv) {
    row.score = Math.round(row.score)
    row.median = median(Object.values(row.metrics).map((row) => row.value))
  }

  return rv
}

module.exports = {
  getData,
}
