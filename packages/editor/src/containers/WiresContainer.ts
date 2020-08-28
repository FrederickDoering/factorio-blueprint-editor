import * as PIXI from 'pixi.js'
import FD from '@fbe/factorio-data'
import U from '../core/generators/util'
import { Entity } from '../core/Entity'
import { Blueprint } from '../core/Blueprint'
import { IConnection } from '../core/WireConnections'
import { EntityContainer } from './EntityContainer'

export class WiresContainer extends PIXI.Container {
    private readonly bp: Blueprint
    private connectionToSprite = new Map<string, PIXI.Graphics>()
    private passiveConnToSprite = new Map<string, PIXI.Graphics>()
    private entNrToConnectedEntNrs = new Map<number, number[]>()

    public constructor(bp: Blueprint) {
        super()
        this.bp = bp
    }

    private static createWire(p1: IPoint, p2: IPoint, color: string): PIXI.Graphics {
        const wire = new PIXI.Graphics()

        const minX = Math.min(p1.x, p2.x)
        const minY = Math.min(p1.y, p2.y)
        const maxX = Math.max(p1.x, p2.x)
        const maxY = Math.max(p1.y, p2.y)
        const dX = maxX - minX
        const dY = maxY - minY

        const colorMap: Record<string, number> = {
            copper: 0xcf7c00,
            red: 0xc83718,
            green: 0x588c38,
        }

        wire.lineStyle(1.5, colorMap[color])
        wire.moveTo(0, 0)

        if (p1.x === p2.x) {
            wire.lineTo(dX, dY)
        } else {
            const d = Math.sqrt(dX * dX + dY * dY)
            const a = Math.atan2(dX, -dY)
            const height = Math.sin(a) * Math.min(1, d / 32 / 3) * 30

            const slope = dY / dX
            const uX = -dY / d
            const uY = dX / d

            const oX = dX / 5
            const oY = slope * oX
            const oX2 = (dX / 5) * 4
            const oY2 = slope * oX2

            const X = oX + height * uX
            const Y = oY + height * uY
            const X2 = oX2 + height * uX
            const Y2 = oY2 + height * uY

            wire.bezierCurveTo(X, Y, X2, Y2, dX, dY)
        }

        wire.position.set(minX + dX / 2, minY + dY / 2)
        wire.pivot.set(dX / 2, dY / 2)

        if (!((p1.x < p2.x && p1.y < p2.y) || (p2.x < p1.x && p2.y < p1.y))) {
            wire.scale.x = -1
        }

        return wire
    }

    public add(hash: string, connection: IConnection): void {
        const sprite = this.getWireSprite(connection)
        this.addChild(sprite)
        this.connectionToSprite.set(hash, sprite)
    }

    public remove(hash: string): void {
        const sprite = this.connectionToSprite.get(hash)
        if (sprite) {
            sprite.destroy()
            this.connectionToSprite.delete(hash)
        }
    }

    /** This is done in cases where the connection doesn't change but the rotation does */
    private redrawEntityConnections(entityNumber: number): void {
        const hashes = this.bp.wireConnections.getEntityConnectionHashes(entityNumber)
        for (const hash of hashes) {
            const connection = this.bp.wireConnections.get(hash)
            this.remove(hash)
            this.add(hash, connection)
        }
    }

    public update(entity: Entity): void {
        if (entity.type === 'electric_pole') {
            // Remove connection so that updatePassiveWires diffs correctly
            for (const [k, v] of this.passiveConnToSprite) {
                if (k.includes(entity.entityNumber.toString())) {
                    v.destroy()
                    this.passiveConnToSprite.delete(k)
                }
            }

            this.updatePassiveWires()
        }

        this.redrawEntityConnections(entity.entityNumber)
    }

    private getWireSprite(connection: IConnection): PIXI.Graphics {
        const getWirePos = (entityNumber: number, color: string, side: number): IPoint => {
            const entity = this.bp.entities.get(entityNumber)
            const direction =
                entity.type === 'electric_pole'
                    ? this.getPowerPoleDirection(entity)
                    : entity.direction
            const point = entity.getWireConnectionPoint(color, side, direction)
            return {
                x: (entity.position.x + point[0]) * 32,
                y: (entity.position.y + point[1]) * 32,
            }
        }

        return WiresContainer.createWire(
            getWirePos(connection.entityNumber1, connection.color, connection.entitySide1),
            getWirePos(connection.entityNumber2, connection.color, connection.entitySide2),
            connection.color
        )
    }

    public getPowerPoleDirection(entity: Entity): number {
        const entNrArr = this.entNrToConnectedEntNrs.get(entity.entityNumber)
        if (!entNrArr) return 0

        const points = entNrArr
            .map(entNr => this.bp.entities.get(entNr))
            .filter(e => !!e)
            .map(ent => ent.position)

        // TODO: this should not happen - find out why it does
        if (points.length === 0) return 0

        return getPowerPoleRotation(entity.position, points)

        function getPowerPoleRotation(centre: IPoint, points: IPoint[]): number {
            const sectorSum = points
                .map(p =>
                    U.getAngle(0, 0, p.x - centre.x, (p.y - centre.y) * -1 /* invert Y axis */)
                )
                .map(angleToSector)
                .reduce((acc, sec) => acc + sec, 0)

            return Math.floor(sectorSum / points.length) * 2

            function angleToSector(angle: number): 0 | 1 | 2 | 3 {
                const cwAngle = 360 - angle
                const sectorAngle = 360 / 8
                const offset = sectorAngle * 1.5
                let newAngle = cwAngle - offset
                if (Math.sign(newAngle) === -1) {
                    newAngle = 360 + newAngle
                }
                const sector = Math.floor(newAngle / sectorAngle)
                return (sector % 4) as 0 | 1 | 2 | 3
            }
        }
    }

    public updatePassiveWires(): void {
        interface IPole extends IPoint {
            entityNumber: number
            name: string
        }

        const poles: IPole[] = this.bp.entities
            .filter(e => e.type === 'electric_pole')
            .map(e => ({
                entityNumber: e.entityNumber,
                name: e.name,
                x: e.position.x,
                y: e.position.y,
            }))

        if (poles.length < 2) {
            for (const [hash, sprite] of this.passiveConnToSprite) {
                sprite.destroy()
                this.passiveConnToSprite.delete(hash)
            }
            return
        }

        const lineHash = (line: { entityNumber: number }[]): string => {
            const min = Math.min(line[0].entityNumber, line[1].entityNumber)
            const max = Math.max(line[0].entityNumber, line[1].entityNumber)
            return `${min}-${max}`
        }

        const setsOfLines = U.pointsToTriangles(poles).map(tri =>
            tri
                .flatMap((_, i, arr) => {
                    if (i === arr.length - 1) return [[arr[0], arr[i]]]
                    return [[arr[i], arr[i + 1]]]
                })
                .filter(line =>
                    U.pointInCircle(
                        line[0],
                        line[1],
                        Math.min(
                            FD.entities[line[0].name].maximum_wire_distance,
                            FD.entities[line[1].name].maximum_wire_distance
                        )
                    )
                )
        )

        const lines = setsOfLines
            .flat()
            .sort((a, b) => {
                const minPos = (l: IPole[]): number =>
                    Math.min(l[0].x, l[1].x) + Math.min(l[0].y, l[1].y)
                return minPos(a) - minPos(b)
            })
            .sort((a, b) => U.manhattenDistance(a[0], a[1]) - U.manhattenDistance(b[0], b[1]))

        const triangles = setsOfLines
            .filter(lines => lines.length === 3)
            .map(lines => lines.map(lineHash))

        const finalLines: IPole[][] = []
        const addedMap: Set<string> = new Set()

        while (lines.length) {
            const line = lines.shift()
            const hash = lineHash(line)

            const formsATriangle = triangles
                .filter(tri => tri.includes(hash))
                .map(tri => tri.filter(h => h !== hash))
                .map(oLines => oLines.every(h => addedMap.has(h)))
                .reduce((acc, bool) => acc || bool, false)

            if (!formsATriangle) {
                finalLines.push(line)
                addedMap.add(hash)
            }
        }

        this.entNrToConnectedEntNrs = finalLines.reduce<Map<number, number[]>>((map, line) => {
            const eNr0 = line[0].entityNumber
            const eNr1 = line[1].entityNumber

            const arr0 = map.get(eNr0)
            if (arr0 && !arr0.includes(eNr1)) {
                arr0.push(eNr1)
            }
            if (!arr0) {
                map.set(eNr0, [eNr1])
            }

            const arr1 = map.get(eNr1)
            if (arr1 && !arr1.includes(eNr0)) {
                arr1.push(eNr0)
            }
            if (!arr1) {
                map.set(eNr1, [eNr0])
            }

            return map
        }, new Map())

        const finalLinesHashes = new Map(finalLines.map(line => [lineHash(line), line]))
        const toAdd = [...finalLinesHashes.keys()].filter(k => !this.passiveConnToSprite.get(k))
        const toDel = [...this.passiveConnToSprite.keys()].filter(k => !finalLinesHashes.get(k))

        // update rotations
        const toUpdate = [...toAdd, ...toDel].reduce<number[]>((arr, hash) => {
            const entNr0 = Number(hash.split('-')[0])
            const entNr1 = Number(hash.split('-')[1])
            if (!arr.includes(entNr0)) {
                arr.push(entNr0)
            }
            if (!arr.includes(entNr1)) {
                arr.push(entNr1)
            }
            return arr
        }, [])

        const addWire = (hash: string): void => {
            const sprite = this.getWireSprite({
                color: 'copper',
                entityNumber1: Number(hash.split('-')[0]),
                entityNumber2: Number(hash.split('-')[1]),
                entitySide1: 1,
                entitySide2: 1,
            })
            this.addChild(sprite)
            this.passiveConnToSprite.set(hash, sprite)
        }

        const removeWire = (hash: string): void => {
            this.passiveConnToSprite.get(hash).destroy()
            this.passiveConnToSprite.delete(hash)
        }

        for (const entNr of toUpdate) {
            const ec = EntityContainer.mappings.get(entNr)
            if (this.bp.entities.get(entNr) && ec) {
                // redraw to update direction
                ec.redraw()

                // redraw red and green connections if needed
                this.redrawEntityConnections(ec.entity.entityNumber)

                // redraw connected wires
                if (this.entNrToConnectedEntNrs.has(entNr)) {
                    for (const eNr of this.entNrToConnectedEntNrs.get(entNr)) {
                        const hash = lineHash([{ entityNumber: eNr }, { entityNumber: entNr }])
                        if (this.passiveConnToSprite.has(hash)) {
                            removeWire(hash)
                            addWire(hash)
                        }
                    }
                }
            }
        }

        toAdd.forEach(addWire)
        toDel.forEach(removeWire)
    }
}
