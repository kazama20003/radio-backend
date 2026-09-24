import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcryptjs';
import {
  ChannelType,
  ConversationType,
  PrismaClient,
  Role,
  Shift,
  UnitStatus,
} from '../generated/prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const password = await bcrypt.hash('mape1234', 10);

  // Supervisor
  const brayan = await prisma.user.upsert({
    where: { email: 'brayan@mape.app' },
    update: {},
    create: {
      email: 'brayan@mape.app',
      passwordHash: password,
      name: 'Brayan Torres',
      role: Role.SUPERVISOR,
      shift: Shift.MANANA,
      positionTitle: 'Supervisor de operaciones',
      phone: '+51 987 654 321',
      avatarKey: 'me',
    },
  });

  // Operadores + unidades
  const operadores = [
    { name: 'Juan Pérez', code: 'T-102', plate: 'ABC-123', brand: 'Volvo', model: 'FH 460', avatar: 'juan' },
    { name: 'Luis Mendoza', code: 'T-118', plate: 'DEF-456', brand: 'Scania', model: 'R450', avatar: 'luis' },
    { name: 'Carlos Ruiz', code: 'T-097', plate: 'GHI-789', brand: 'Volvo', model: 'FMX', avatar: 'carlos' },
    { name: 'Rosa Díaz', code: 'T-121', plate: 'JKL-012', brand: 'Mercedes', model: 'Actros', avatar: 'rosa' },
  ];

  for (const [i, op] of operadores.entries()) {
    const email = `${op.avatar}@mape.app`;
    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        passwordHash: password,
        name: op.name,
        role: Role.OPERATOR,
        operatorCode: op.code,
        avatarKey: op.avatar,
        isOnline: i < 3,
      },
    });
    await prisma.unit.upsert({
      where: { code: op.code },
      update: {},
      create: {
        code: op.code,
        plate: op.plate,
        brand: op.brand,
        model: op.model,
        capacityTons: 20,
        status: i < 2 ? UnitStatus.EN_RUTA : UnitStatus.DETENIDO,
        operatorId: user.id,
        lastLat: -12.05 + i * 0.01,
        lastLng: -77.05 + i * 0.01,
        lastSpeedKmh: i < 2 ? 45 : 0,
        lastPositionAt: new Date(),
      },
    });
  }

  // Canal de radio
  await prisma.channel.upsert({
    where: { id: 'seed-canal-1' },
    update: {},
    create: {
      id: 'seed-canal-1',
      name: 'Canal 1',
      type: ChannelType.OPERACIONES,
      description: 'Operaciones',
    },
  });

  // Geocerca de ejemplo (Almacén Central)
  await prisma.geofence.upsert({
    where: { id: 'seed-almacen' },
    update: {},
    create: {
      id: 'seed-almacen',
      name: 'Almacén Central',
      type: 'ALMACEN',
      centerLat: -12.05,
      centerLng: -77.05,
      radiusMeters: 300,
    },
  });

  // Conversación de grupo
  const juan = await prisma.user.findUnique({ where: { email: 'juan@mape.app' } });
  await prisma.conversation.create({
    data: {
      type: ConversationType.GROUP,
      title: 'Operaciones · Turno mañana',
      createdById: brayan.id,
      lastMessageAt: new Date(),
      members: {
        create: [
          { userId: brayan.id, isAdmin: true },
          ...(juan ? [{ userId: juan.id }] : []),
        ],
      },
    },
  });

  console.log('Seed completado. Login: brayan@mape.app / mape1234');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
