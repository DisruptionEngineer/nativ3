#!/usr/bin/env python3
"""Nativ3 Comprehensive Verification Suite — Theorems 15-19"""
import numpy as np
from numpy.linalg import eigvals, det
import time
pi = np.pi

def Ry(t): return np.array([[np.cos(t/2),-np.sin(t/2)],[np.sin(t/2),np.cos(t/2)]])
def apply_ry_v(psi,q,theta,n):
    dim=2**n;r=np.zeros(dim,dtype=complex);cv,sv=np.cos(theta/2),np.sin(theta/2)
    for i in range(dim):
        tb=(i>>(n-1-q))&1;j0=i&~(1<<(n-1-q));j1=j0|(1<<(n-1-q))
        if tb==0:r[i]+=cv*psi[j0]-sv*psi[j1]
        else:r[i]+=sv*psi[j0]+cv*psi[j1]
    return r
def apply_h_v(psi,q,n):
    dim=2**n;r=np.zeros(dim,dtype=complex);s=1/np.sqrt(2)
    for i in range(dim):
        tb=(i>>(n-1-q))&1;j0=i&~(1<<(n-1-q));j1=j0|(1<<(n-1-q))
        if tb==0:r[i]+=s*psi[j0]+s*psi[j1]
        else:r[i]+=s*psi[j0]-s*psi[j1]
    return r
def apply_cu_v(psi,ctrl,targ,U,n):
    dim=2**n;r=np.zeros(dim,dtype=complex)
    for i in range(dim):
        if(i>>(n-1-ctrl))&1==0:r[i]+=psi[i]
        else:
            tb=(i>>(n-1-targ))&1;p=i^(1<<(n-1-targ))
            if tb==0:r[i]+=U[0,0]*psi[i]+U[0,1]*psi[p]
            else:r[i]+=U[1,0]*psi[p]+U[1,1]*psi[i]
    return r
def cu_N_complex(alphas,beta,U):
    N=len(alphas);n=N+2;psi=np.zeros(2**n,dtype=complex);psi[0]=1.0
    psi=apply_h_v(psi,0,n)
    for k,a in enumerate(alphas):
        if abs(a)>1e-15:psi=apply_ry_v(psi,k+1,2*a,n)
    if abs(beta)>1e-15:psi=apply_ry_v(psi,n-1,2*beta,n)
    star=psi.copy();chain=psi.copy()
    for k in range(1,n):star=apply_cu_v(star,0,k,U,n)
    for k in range(n-1):chain=apply_cu_v(chain,k,k+1,U,n)
    return np.dot(star.conj(),chain)
def make_M(alpha,U):
    a,b,c,d=U[0,0],U[0,1],U[1,0],U[1,1];ca,sa=np.cos(alpha),np.sin(alpha)
    r0=a*ca+b*sa;r1=c*ca+d*sa
    return np.array([[ca**2,sa**2,0,0],[ca*r0,sa*r1,0,0],[0,0,ca*r0.conj(),sa*r1.conj()],[0,0,abs(r0)**2,abs(r1)**2]])
def make_base(beta,U):
    a,b,c,d=U[0,0],U[0,1],U[1,0],U[1,1];cb,sb=np.cos(beta),np.sin(beta)
    xi=a*cb**2+(b+c)*cb*sb+d*sb**2;return np.array([1,xi,xi.conj(),1],dtype=complex)
def readout_z(alpha,ABCD,U):
    a,b,c,d=U[0,0],U[0,1],U[1,0],U[1,1];ca,sa=np.cos(alpha),np.sin(alpha)
    r0=a*ca+b*sa;r1=c*ca+d*sa
    return 0.5*(ca**2*ABCD[0]+sa**2*ABCD[1]+abs(r0)**2*ABCD[2]+abs(r1)**2*ABCD[3])
def find_projector(U):
    a,b,c,d=U.ravel().real;P,Q,K=b+c,d-a,b-c;R=np.sqrt(P**2+Q**2)
    if R<1e-10:return None
    ratio=np.clip(K/R,-1,1);phi=np.arctan2(Q,P)
    for sign in[1,-1]:
        alpha=(phi+sign*np.arccos(ratio))/2
        if 0.01<alpha<pi/2-0.01:return alpha
    return None

GATES={
    "C-X":np.array([[0,1],[1,0]],dtype=complex),
    "C-Z":np.array([[1,0],[0,-1]],dtype=complex),
    "C-Y":np.array([[0,-1j],[1j,0]],dtype=complex),
    "C-H":np.array([[1,1],[1,-1]],dtype=complex)/np.sqrt(2),
    "C-Ry45":Ry(pi/4).astype(complex),"C-Ry90":Ry(pi/2).astype(complex),
    "C-Ry60":Ry(pi/3).astype(complex),"C-S":np.array([[1,0],[0,1j]],dtype=complex),
    "C-T":np.array([[1,0],[0,np.exp(1j*pi/4)]],dtype=complex),
    "C-sqX":np.array([[1+1j,1-1j],[1-1j,1+1j]],dtype=complex)/2,
}
t0=time.time()
results={}
total_tests=0;total_pass=0

# ═══ T16: UNIVERSAL 4×4 TRANSFER MATRIX ═══
print("T16: Universal 4×4 Transfer Matrix")
t16_pass=0;t16_total=0
for name,U in GATES.items():
    for N in range(1,7):
        nt=300 if N<=4 else 150
        fails=0
        for _ in range(nt):
            alphas=[np.random.uniform(0.05,pi/2-0.05) for _ in range(N)]
            beta=np.random.uniform(0.05,pi/2-0.05)
            state=make_base(beta,U)
            for ak in reversed(alphas[1:]):state=make_M(ak,U)@state
            z_pred=readout_z(alphas[0],state,U)
            z_actual=cu_N_complex(alphas,beta,U)
            if abs(z_pred-z_actual)>1e-6:fails+=1
        t16_pass+=nt-fails;t16_total+=nt
print(f"  {t16_pass}/{t16_total} ({'✓' if t16_pass==t16_total else '✗'})")
results['T16']=(t16_pass,t16_total)
total_tests+=t16_total;total_pass+=t16_pass

# ═══ T17: PROJECTOR ANGLE FORMULA ═══
print("T17: Projector Angle (det=0, M²=λ₁M)")
t17_pass=0;t17_total=0
np.random.seed(42)
for _ in range(500):
    t=np.random.uniform(0.2,pi-0.2)
    if np.random.random()<0.5:U=np.array([[np.cos(t),np.sin(t)],[np.sin(t),-np.cos(t)]])
    else:U=np.array([[np.cos(t),-np.sin(t)],[np.sin(t),np.cos(t)]])
    U_c=U.astype(complex);ap=find_projector(U_c)
    if ap is None:continue
    M=make_M(ap,U_c);M2=M@M;eigs=eigvals(M);lam1=max(abs(e) for e in eigs)
    t17_total+=1
    if np.max(np.abs(M2-lam1*M))<1e-4:t17_pass+=1
print(f"  {t17_pass}/{t17_total} ({'✓' if t17_pass==t17_total else '✗'})")
results['T17']=(t17_pass,t17_total)
total_tests+=t17_total;total_pass+=t17_pass

# ═══ T17b: θ/4 FOR REFLECTIONS ═══
print("T17b: θ/4 for reflections (M²=M, λ₁=1)")
t17b_pass=0;t17b_total=0
for theta_deg in range(10,180,5):
    theta=theta_deg*pi/180;a_v,b_v=np.cos(theta/2),np.sin(theta/2)
    U=np.array([[a_v,b_v],[b_v,-a_v]],dtype=complex)
    alpha=theta/4;M=make_M(alpha,U);M2=M@M
    t17b_total+=1
    if np.max(np.abs(M2-M))<1e-10:t17b_pass+=1
print(f"  {t17b_pass}/{t17b_total} ({'✓' if t17b_pass==t17b_total else '✗'})")
results['T17b']=(t17b_pass,t17b_total)
total_tests+=t17b_total;total_pass+=t17b_pass

# ═══ T17c: F_∞ = (1+ξ)/2 at projector ═══
print("T17c: F_∞ = (1+ξ)/2 for reflections")
t17c_pass=0;t17c_total=0
for theta_deg in range(10,180,10):
    theta=theta_deg*pi/180;a_v,b_v=np.cos(theta/2),np.sin(theta/2)
    U=np.array([[a_v,b_v],[b_v,-a_v]],dtype=complex);alpha=theta/4
    for beta_deg in range(5,90,10):
        beta=beta_deg*pi/180;base=make_base(beta,U);xi=base[1].real
        state=base.copy()
        for _ in range(100):state=make_M(alpha,U)@state
        f_actual=readout_z(alpha,state,U).real;f_pred=(1+xi)/2
        t17c_total+=1
        if abs(f_actual-f_pred)<1e-4:t17c_pass+=1
print(f"  {t17c_pass}/{t17c_total} ({'✓' if t17c_pass==t17c_total else '✗'})")
results['T17c']=(t17c_pass,t17c_total)
total_tests+=t17c_total;total_pass+=t17c_pass

# ═══ T18: EIGENVALUE FORMULAS ═══
print("T18: Trace and det formulas for C-Ry(θ)")
t18_pass=0;t18_total=0
for theta_deg in [30,45,60,90,120,150,180]:
    theta=theta_deg*pi/180;U=Ry(theta).astype(complex)
    for alpha_deg in range(1,89,3):
        alpha=alpha_deg*pi/180;M_up=make_M(alpha,U)[:2,:2]
        tr_num=np.trace(M_up).real
        tr_formula=np.cos(theta/4)**2+np.sin(theta/4)*np.sin(2*alpha+theta/4)
        det_num=det(M_up).real
        det_formula=np.sin(2*alpha)*np.sin(theta/4)*np.cos(theta/4)
        t18_total+=2
        if abs(tr_num-tr_formula)<1e-10:t18_pass+=1
        if abs(det_num-det_formula)<1e-10:t18_pass+=1
print(f"  {t18_pass}/{t18_total} ({'✓' if t18_pass==t18_total else '✗'})")
results['T18']=(t18_pass,t18_total)
total_tests+=t18_total;total_pass+=t18_pass

# ═══ T19: EIGENVECTOR CONNECTION ═══
print("T19: ρ satisfies characteristic equation of U")
t19_pass=0;t19_total=0
np.random.seed(42)
for _ in range(500):
    U=np.random.randn(2,2);U_c=U.astype(complex);ap=find_projector(U_c)
    if ap is None:continue
    a,b,c,d=U.ravel();ca,sa=np.cos(ap),np.sin(ap)
    r0=a*ca+b*sa;rho=r0/ca if abs(ca)>0.01 else(c*ca+d*sa)/sa
    eigs_U=np.linalg.eigvals(U);min_dist=min(abs(rho-e) for e in eigs_U)
    t19_total+=1
    if min_dist<1e-6:t19_pass+=1
print(f"  {t19_pass}/{t19_total} ({'✓' if t19_pass==t19_total else '✗'})")
results['T19']=(t19_pass,t19_total)
total_tests+=t19_total;total_pass+=t19_pass

# ═══ T19b: RELAY IS EIGENVECTOR OF U ═══
print("T19b: U|ψ_relay⟩ = ρ|ψ_relay⟩ at projector")
t19b_pass=0;t19b_total=0
np.random.seed(42)
for _ in range(500):
    U=np.random.randn(2,2);U_c=U.astype(complex);ap=find_projector(U_c)
    if ap is None:continue
    psi=np.array([np.cos(ap),np.sin(ap)]);Upsi=U@psi
    if abs(psi[0])>1e-10:rho=Upsi[0]/psi[0]
    else:rho=Upsi[1]/psi[1]
    t19b_total+=1
    if np.max(np.abs(Upsi-rho*psi))<1e-6:t19b_pass+=1
print(f"  {t19b_pass}/{t19b_total} ({'✓' if t19b_pass==t19b_total else '✗'})")
results['T19b']=(t19b_pass,t19b_total)
total_tests+=t19b_total;total_pass+=t19b_pass

# ═══ STOCHASTIC CONDITION ═══
print("Stochastic: M_upper rows sum to 1 at projector")
st_pass=0;st_total=0
for theta_deg in range(10,180,5):
    theta=theta_deg*pi/180;a_v,b_v=np.cos(theta/2),np.sin(theta/2)
    U=np.array([[a_v,b_v],[b_v,-a_v]],dtype=complex);alpha=theta/4
    M_up=make_M(alpha,U)[:2,:2].real
    st_total+=2
    if abs(sum(M_up[0])-1)<1e-10:st_pass+=1
    if abs(sum(M_up[1])-1)<1e-10:st_pass+=1
print(f"  {st_pass}/{st_total} ({'✓' if st_pass==st_total else '✗'})")
results['Stochastic']=(st_pass,st_total)
total_tests+=st_total;total_pass+=st_pass

# ═══ REVERSE MAP ═══
print("Reverse: classical stochastic → quantum gate")
rv_pass=0;rv_total=0
np.random.seed(42)
for _ in range(200):
    p=np.random.uniform(0.1,0.9);q=np.random.uniform(0.05,0.95)
    alpha=np.arccos(np.sqrt(p));ca,sa=np.cos(alpha),np.sin(alpha)
    if ca<0.01 or sa<0.01:continue
    r0=q/ca;r1=(1-q)/sa;denom=r0/sa+r1/ca
    if abs(denom)<1e-10:continue
    b_v=(r0*r1/(ca*sa)+1)/denom;a_v=(r0-b_v*sa)/ca;d_v=(r1-b_v*ca)/sa
    U=np.array([[a_v,b_v],[b_v,d_v]],dtype=complex)
    M=make_M(alpha,U);M_up=M[:2,:2].real;target=np.array([[p,1-p],[q,1-q]])
    rv_total+=1
    if np.max(np.abs(M_up-target))<1e-6:rv_pass+=1
print(f"  {rv_pass}/{rv_total} ({'✓' if rv_pass==rv_total else '✗'})")
results['Reverse']=(rv_pass,rv_total)
total_tests+=rv_total;total_pass+=rv_pass

elapsed=time.time()-t0
print(f"\n{'═'*60}")
print(f"  TOTAL: {total_pass}/{total_tests}")
print(f"  Time: {elapsed:.1f}s")
print(f"{'═'*60}")
for k,(p,t) in results.items():
    print(f"  {k:<15s}: {p:>6d}/{t:<6d} {'✓' if p==t else '✗'}")
print(f"{'═'*60}")
