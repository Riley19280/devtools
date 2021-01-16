require('dotenv').config()
const fetch = require('node-fetch')
const fs = require('fs-extra')

exports.create_zone = (domain) => {
    return fetch('https://api.cloudflare.com/client/v4/zones', {
        method: 'post',
        body: JSON.stringify({
            name: domain,
            account: {
                id: process.env.CLOUDFLARE_ACCOUNT_ID
            }
        }),
        headers: {
            'X-Auth-Email': process.env.CLOUDFLARE_EMAIL,
            'X-Auth-Key': process.env.CLOUDFLARE_API_KEY,
            'Content-Type': 'application/json'
        }
    })
    .then(res => res.json())
    .then(data => {

        if(data.success && data.result) {
            console.log(`Created zone ${domain} with id: ${data.result.id}`)
            return data.result.id
        }
        else {
            // console.error(data)
            return null
        }

    })
}

exports.get_zone = (domain) => {
    return fetch(`https://api.cloudflare.com/client/v4/zones?name=${domain}`, {
        method: 'get',
        headers: {
            'X-Auth-Email': process.env.CLOUDFLARE_EMAIL,
            'X-Auth-Key': process.env.CLOUDFLARE_API_KEY,
            'Content-Type': 'application/json'
        }
    })
    .then(res => res.json())
    .then(data => {
        if(data.success && data.result && data.result.length > 0) {
            console.log(`Fetched existing zone for ${domain}, id: ${data.result[0].id}`)
            return data.result[0].id
        }
        else {
            console.error(data)
            return null
        }
    })
}

exports.create_dns_record = (zone_id, record) => {
    return fetch(`https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records`, {
        method: 'post',
        body: JSON.stringify({
            type: record.type,
            name: record.name,
            content: record.value,
            ttl: 1,
            proxied: record.proxied,
            priority: record.type === 'MX' ? record.priority : undefined
        }),
        headers: {
            'X-Auth-Email': process.env.CLOUDFLARE_EMAIL,
            'X-Auth-Key': process.env.CLOUDFLARE_API_KEY,
            'Content-Type': 'application/json'
        }
    })
    .then(res => res.json())
    .then(data => {
        let r = record.value
        let match = record.value.match(/[a-zA-Z0-9]*?\\.[a-zA-Z0-9]*?$/)
        if(match && match[0])
            r = match[0]

        console.log(`Created ${record.type} record ${r}`)
        return data
    })
}

exports.initialize_domain = (domain, dns_recordset) => {
    let data = {}
    return exports.get_zone(domain)
    .then(zone_id => {
        if(!zone_id)
            return exports.create_zone(domain)
        else
            return zone_id
    })
    .then(async zone_id => {
        data.zone_id = zone_id
        for(let record of dns_recordset) {
            await exports.create_dns_record(zone_id, record)
        }
    })
    .then(() => {
        return data
    })
}



(async () => {
    const config = fs.readJsonSync('./output.json')

   //  console.log(await exports.get_zone(`${config.PROJECT}.${config.DOMAIN}`))
})()