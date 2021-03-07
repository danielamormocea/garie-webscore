const sleep = require('sleep-promise');
const { influx } = require('./queries');
const queries = require('./queries');
const cron = require('node-cron');

const {
    send_email_first_place,
    send_email_entered_top_five,
    send_email_exited_top_five,
    send_email_above_median,
    send_email_below_median,
    send_email_bottom_five
} = require('./email');

const DATABASE_NAME = 'leaderboard';
const CONSISTENCY_LENGTH = 3;

cron.schedule('0 7 * * 3', async()=> send_notification());

const urlSlug = (url) => {
    return url
      .replace(/^http[s]?:\/\//, '')
      .replace(/\/$/, '')
      .replace(/[^a-zA-Z0-9.]+/g, '-')
}

async function update_email_for_url(url, email, active) {

    try{
        const point = {
            measurement: "application-emails",
            tags: {
                url: url,
                email: email,
                active: active
            },
            fields: {date: Date.now() }
        }

        await influx.writePoints([point], {database: DATABASE_NAME});
        console.log(`Successfully saved email ${email} for the application ${url} as ${active}.`);
    } catch (err) {
        console.log(`Failed to save email ${email} for application ${url}.`);
        console.log(err);
        return Promise.reject(`Failed to save email ${email} for application ${url}.`);
    }
}

async function get_all_emails() {
    //get emails from database
    let emails = {};
    const query = 'select * from "application-emails" order by "time" asc';
    try{
        result = await influx.query(query, {database: DATABASE_NAME});
    } catch(err) {
        console.log(err);
        return emails;
    }

    for (let elem of result) {
        emails[elem.url] = emails[elem.url] || {};
        const active = parseInt(elem.active);
        emails[elem.url][elem.email] = active;
    }
    return emails;
}

async function create_db() {
    try {
        const names = await influx.getDatabaseNames();
        if (names.indexOf(DATABASE_NAME) === -1) {
            console.log("Influx: leaderboard database does not exist. Creating Database.");
            await influx.createDatabase(DATABASE_NAME);
        }
        return Promise.resolve();
    } catch (err) {
        console.log(`Influx: Error when creating database ${err}`);
        return Promise.reject('Failed to create database leaderboard');
    }
}


async function init_leaderboard_influx() {
    let retries = 0;
    while(true) {
        try {
            console.log('Trying to connect to influx');
            await create_db();
            console.log('Connected to influx');
            break;
        }catch(err) {
            retries++;
            if (retries < 60) {
                console.log(`Failed to connect to influx, retry ${retries}`);
                await sleep(1000);
            } else {
                throw(err);
            }
        }
    }
}


function map_data(data) {  
    let urls_map = {};

    for (const row of data) {
        let metrics = {};
        for (const metric in row.metrics) {
            metrics[metric] = row.metrics[metric].value;
        }
        urls_map[row.url] = {
            metrics,
            score: row.score
        };
    }
    return urls_map;
}


function sort_data(urls_map, keep_negatives=false) {
    let urls_array_sorted = [];
    for (const key in urls_map) {
        urls_map[key].score = parseInt(urls_map[key].score, 10);
        if (!keep_negatives) {
            if (!Number.isNaN(urls_map[key].score) && (urls_map[key].score !== -1) ) {
                urls_array_sorted.push({
                    url: key,
                    score: urls_map[key].score
                });
            }
        } else {
            if (!Number.isNaN(urls_map[key].score)) {
                urls_array_sorted.push({
                    url: key,
                    score: urls_map[key].score
                });
            }
        }
        
    }

    urls_array_sorted.sort(function(a, b) {
        return b.score - a.score;
    });

    return urls_array_sorted;
}


async function update_influx(urls_array_sorted) {
    let points = [];
    try {
        for (let i = 0; i < urls_array_sorted.length; i++) {
            points.push( {
                measurement: "webscore-leaderboard",
                tags: {
                    url: urls_array_sorted[i].url,
                    score: urls_array_sorted[i].score
                },
                fields: { date: Date.now() }
            })
        }

        const result = await influx.writePoints(points, {database: DATABASE_NAME});
        console.log(`Successfully saved ${points.length} applications into database leaderboard`);
        return result;
    } catch (err) {
        console.log(`Failed to add applications to leaderboard database. ${points.length} apps. ${err}`);
        return Promise.reject(`Failed to add applications to leaderboard database. ${points.length} apps. ${err}`);
    }
}


async function get_last_entries() {
    const query =  'select * from "webscore-leaderboard" where time >= now() - 7d';
    let result = [];
    let last_urls_map = {};
    try {
        result = await influx.query(query, { database: DATABASE_NAME });
    } catch(err) {
        console.log(err);
        return last_urls_map;
    }
    
    for (const elem of result) {
        last_urls_map[elem.url] = {
            score: elem.score
        }
    }

    return last_urls_map;
}


function get_mapped_scores(scores_sorted) {
    let scores_sorted_map = [];

    for(let i = 0; i < scores_sorted.length; i++) {
        scores_sorted_map.push({});
        for (const elem of scores_sorted[i]) {
            scores_sorted_map[i][elem.url] = elem.score;
        }
    }
    return scores_sorted_map;
}


//either all true or all false;
function check_consistency_topk(k, url, scores_sorted, scores_sorted_map) {
    let last_outside_topk = null;

    for (let i = 0; i < scores_sorted.length; i++) {
        if ((scores_sorted_map[i][url] === undefined) || (scores_sorted[i][k] === undefined)) {
            return false;
        }
        
        const outside_topk = (scores_sorted_map[i][url] <= scores_sorted[i][k].score);
        if ((last_outside_topk !== null) && (last_outside_topk !== outside_topk)) {
            return false;
        }

        last_outside_topk = outside_topk;
    }
    return true;
}


function check_consistency_bottomk(k, url, scores_sorted, scores_sorted_map) {
    let last_outside_bottomk = null;

    for (let i = 0; i < scores_sorted.length; i++) {
        if ((scores_sorted_map[i][url] === undefined) || ( scores_sorted[i][scores_sorted[i].length - k] === undefined)) {
            return false;
        }
        const outside_bottomk = (scores_sorted_map[i][url] > scores_sorted[i][scores_sorted[i].length - k].score);
        if ((last_outside_bottomk !== null) && (last_outside_bottomk !== outside_bottomk)) {
            return false;
        }

        last_outside_bottomk = outside_bottomk;
    }
    return true;
}

function check_consistency_median(url, scores_sorted, scores_sorted_map) {
    let last_below_median = null;

    for (let i = 0; i < scores_sorted.length; i++) {
        if (scores_sorted_map[i][url] === undefined) {
            return false;
        }
        const median = scores_sorted[i][Math.round(scores_sorted[i].length / 2)].score;
        const below_median = (scores_sorted_map[i][url] < median);

        if ((last_below_median !== null) && (last_below_median !== below_median)) {
            return false;
        }

        last_below_median = below_median;
    }
    return true;
}


async function send_notification() {
    await init_leaderboard_influx();

    const data = await queries.getData();
    for (const row of data) {
        row.url = urlSlug(row.url);
    }

    let emails = await get_all_emails();
    if (Object.keys(emails).length === 0) {
      return;
    }


    let scores = [];
    scores.push({});

    for (let i = 0; i < current_urls_array_sorted.length; i++) {
        scores[0][current_urls_array_sorted[i].url] = {score: current_urls_array_sorted[i].score};
    }

    for (let i = 0; i < CONSISTENCY_LENGTH; i++) {
        scores.push({});
    }

    for(const row of data) {
        for (const metric in row.metrics) {
            const month_values = row.metrics[metric].monthSeries;
            for (let i = 1; i <= CONSISTENCY_LENGTH; i++) {
                if (month_values[14 - i] !== -1) {
                    scores[i][row.url] = scores[i][row.url] || {score: 0};
                    scores[i][row.url].score += parseInt(month_values[14 - i] || 0);
                }
            }
        }
    }

    
    //scores_sorted[0] => one day ago; socres_sorted[1] -> two days ago ... etc
    const scores_sorted = scores.map(map => sort_data(map));
    //await update_influx(scores_sorted[5]);
    const scores_sorted_map = get_mapped_scores(scores_sorted);

    const last_urls_map = await get_last_entries();

    //after querying influx for last week's results, update influx with current scores;
    const urls_map = map_data(data);
    let current_urls_array_sorted = sort_data(urls_map, true);
    await update_influx(current_urls_array_sorted);
    current_urls_array_sorted = sort_data(urls_map, false);
    

    if (Object.keys(last_urls_map).length === 0) {
        console.log("No data found in webscore-leaderboard for last week");
        return;
    }
    const last_urls_array_sorted = sort_data(last_urls_map);
    const last_loserboard = last_urls_array_sorted.slice(last_urls_array_sorted.length - 5, last_urls_array_sorted.length);

   
    const current_leaderboard = current_urls_array_sorted.slice(0, 5);
    const current_loserboard = current_urls_array_sorted.slice(current_urls_array_sorted.length - 5, current_urls_array_sorted.length);


    //check 1st place:
    if (current_urls_array_sorted[0].url !== last_urls_array_sorted[0].url) {
        send_email_first_place(current_urls_array_sorted[0], current_leaderboard, emails);
    }

    //set with old top 5;
    const old_top5_set = new Set();
    for (let i = 0; i < 5; i++) {
        old_top5_set.add(last_urls_array_sorted[i].url);
    }

    //check if current top 5 is the same as old top 5;
    for (let i = 0; i < 5; i++) {
        const is_consistent = check_consistency_topk(5, current_urls_array_sorted[i].url, scores_sorted, scores_sorted_map);
        if (is_consistent) {
            if (!old_top5_set.has(current_urls_array_sorted[i].url)) {
                if (i !== 0) {
                    send_email_entered_top_five(current_urls_array_sorted[i], current_leaderboard, emails);
                }
            } else {
                old_top5_set.delete(current_urls_array_sorted[i].url);
            }
        }
    }

    //check for remnants of old top 5
    for (let elem of old_top5_set) {
        const is_consistent = check_consistency_topk(5, elem, scores_sorted, scores_sorted_map);
        if (is_consistent) {
            send_email_exited_top_five({url: elem, score: urls_map[elem].score}, current_leaderboard, emails);
        }
        
    }

    //check for new consistent entries in bottom 5
    const old_bottom5_set = new Set();
    for (let i = 0; i < 5; i++) {
        old_bottom5_set.add(last_loserboard[i].url);
    }


    for(let i = current_urls_array_sorted.length - 1; i >= current_urls_array_sorted.length - 5; i--) {
        const is_consistent = check_consistency_bottomk(5, current_urls_array_sorted[i].url, scores_sorted, scores_sorted_map);
        if (is_consistent) {
            if (!old_bottom5_set.has(current_urls_array_sorted[i].url)) {
                send_email_bottom_five(current_urls_array_sorted[i], current_leaderboard, emails);
            }
        }
    }

    //notify above and below median;
    const above_median = current_urls_array_sorted.slice(5, Math.round(current_urls_array_sorted.length / 2));
    const below_median = current_urls_array_sorted.slice(Math.round(current_urls_array_sorted.length / 2) + 1, current_urls_array_sorted.length - 5);

    const last_median_score = last_urls_array_sorted[Math.round(last_urls_array_sorted.length / 2)].score;

    for (let i = 0; i < above_median.length; i++) {
        const url = above_median[i].url;
        //if it wasn't last week in the first half, check consistency and send mail;
        if (last_urls_map[url] === undefined) {
            continue;
        }
        if (last_urls_map[url].score < last_median_score) {
            const is_consistent = check_consistency_median(url, scores_sorted, scores_sorted_map);
            if (is_consistent === true) {
                send_email_above_median(above_median[i], current_leaderboard, emails);
            }
        }
    }

    for (let i = 0; i < below_median.length; i++) {
        const url = below_median[i].url;
        if (last_urls_map[url] === undefined) {
            continue;
        }
        // if it wasn't in last week second half, check consistency and send mail;
        if (last_urls_map[url].score > last_median_score) {
            const is_consistent = check_consistency_median(below_median[i], scores_sorted, scores_sorted_map);
            if (is_consistent) {
                send_email_below_median(below_median[i], current_leaderboard, emails);
            }
        }
    }    
}



module.exports = {
    update_email_for_url,
    get_all_emails
}