require('dotenv').config()
const express = require('express')
const nunjucks = require('nunjucks')
const queries = require('./queries')
const metrics = require('./metrics')

const dev = (process.env.NODE_ENV || 'dev') === 'dev'
const config = JSON.parse(
  process.env.CONFIG ||
  require('fs').readFileSync(`${__dirname}/examples/config.json`)
)

if(dev) console.debug('config =', config)

const app = express()
const port = process.env.PORT || '3000'

nunjucks.configure(`${__dirname}/templates`, {
  autoescape: true,
  express: app,
  watch: true
})

function wrap(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next)
    } catch(e) {
      next(e)
    }
  }
}

app.get('/', wrap(async (req, res) => {
  const data = await queries.getData(config)
  res.render('index.html', { data, metrics })
}))

app.get(/^\/site\/(.*)$/, wrap(async (req, res) => {
  const url = req.params[0]
  if (config.urls.indexOf(url) < 0) {
    res.sendStatus(404)
    return
  }
  const data = (await queries.getData(config)).find((row) => row.url === url)
  res.render('site.html', { url, data, metrics })
}))

app.listen(port, () => console.log(`Listening on port ${port}`))
